/* eslint-disable newline-per-chained-call */
'use strict';

const _ = require('lodash');
const url = require('url');
const jose = require('node-jose');
const assert = require('assert');
const base64url = require('base64url');
const got = require('got');

const errors = require('../helpers/errors');
const getSchema = require('../helpers/client_schema');

const KEY_ATTRIBUTES = ['crv', 'e', 'kid', 'kty', 'n', 'use', 'x', 'y'];
const KEY_TYPES = ['RSA', 'EC'];

function handled(kty) {
  return KEY_TYPES.indexOf(kty) !== -1;
}

module.exports = function getClient(provider) {
  const Schema = getSchema(provider);
  const cache = new Map();

  function schemaValidate(client, metadata) {
    try {
      const schema = new Schema(metadata);

      Object.defineProperty(client, 'sectorIdentifier', {
        enumerable: false,
        writable: true,
      });

      Object.assign(client, _.mapKeys(schema, (value, key) => _.camelCase(key)));

      return Promise.resolve(client);
    } catch (err) {
      return Promise.reject(err);
    }
  }

  function sectorValidate(client) {
    if (client.sectorIdentifierUri !== undefined) {
      return got(client.sectorIdentifierUri, {
        headers: {
          'User-Agent': provider.userAgent(),
        },
        timeout: provider.configuration('timeouts.sector_identifier_uri'),
        retries: 0,
        followRedirect: false,
      }).then(res => {
        try {
          assert.ok(res.statusCode === 200,
            `unexpected sector_identifier_uri statusCode, expected 200, got ${res.statusCode}`);
          const body = JSON.parse(res.body);
          assert(Array.isArray(body),
            'sector_identifier_uri must return single JSON array');
          const missing = client.redirectUris.find((uri) => body.indexOf(uri) === -1);
          assert(!missing,
            'all registered redirect_uris must be included in the sector_identifier_uri');
        } catch (err) {
          throw new errors.InvalidClientMetadata(err.message);
        }

        return client;
      }, (error) => {
        throw new errors.InvalidClientMetadata(
          `could not load sector_identifier_uri (${error.message})`);
      });
    }

    return client;
  }

  function buildKeyStore(client) {
    Object.defineProperty(client, 'keystore', { value: jose.JWK.createKeyStore() });
    client.keystore.jwksUri = client.jwksUri;

    client.keystore.refresh = function refreshKeyStore() {
      if (!this.jwksUri) return Promise.resolve();

      return got(this.jwksUri, {
        headers: {
          'User-Agent': provider.userAgent(),
        },
        timeout: provider.configuration('timeouts.jwks_uri'),
        retries: 0,
        followRedirect: false,
      }).then((response) => {
        assert.ok(response.statusCode === 200,
          `unexpected jwks_uri statusCode, expected 200, got ${response.statusCode}`);

        const body = JSON.parse(response.body);

        if (!Array.isArray(body.keys)) throw new Error('invalid jwks_uri response');

        const promises = [];
        const kids = _.map(body.keys, 'kid');

        body.keys.forEach((key) => {
          if (handled(key.kty) && !this.get(key.kid)) {
            promises.push(this.add(_.pick(key, KEY_ATTRIBUTES)));
          }
        });

        this.all().forEach((key) => {
          if (handled(key.kty) && kids.indexOf(key.kid) === -1) {
            promises.push(this.remove(key));
          }
        });

        return Promise.all(promises);
      }).catch((err) => {
        throw new Error(`jwks_uri could not be refreshed (${err.message})`);
      });
    };

    const promises = [];

    if (client.jwks && client.jwks.keys) {
      client.jwks.keys.forEach((key) => {
        if (handled(key.kty)) {
          promises.push(client.keystore.add(_.pick(key, KEY_ATTRIBUTES)));
        }
      });
    }

    promises.push(client.keystore.refresh());

    // TODO: DRY the adding of keys;

    return Promise.all(promises).then(() => {
      client.keystore.add({
        k: base64url(new Buffer(client.clientSecret)),
        kid: 'clientSecret',
        kty: 'oct',
      });
    })
    .then(() => client);
  }

  function register(client) {
    cache.set(client.clientId, client);
    return client;
  }

  class Client {

    static get adapter() {
      const Adapter = provider.configuration('adapter');
      if (!this._adapter) {
        this._adapter = new Adapter(this.name);
      }
      return this._adapter;
    }

    responseTypeAllowed(type) {
      return this.responseTypes.indexOf(type) !== -1;
    }

    grantTypeAllowed(type) {
      return this.grantTypes.indexOf(type) !== -1;
    }

    redirectUriAllowed(uri) {
      return this.redirectUris.indexOf(uri) !== -1;
    }

    requestUriAllowed(uri) {
      const parsedUri = url.parse(uri);
      parsedUri.hash = undefined;
      const formattedUri = url.format(parsedUri);

      return !!_.find(this.requestUris, (enabledUri) => {
        const parsedEnabled = url.parse(enabledUri);
        parsedEnabled.hash = undefined;
        return formattedUri === url.format(parsedEnabled);
      });
    }

    postLogoutRedirectUriAllowed(uri) {
      return this.postLogoutRedirectUris.indexOf(uri) !== -1;
    }

    metadata() {
      return _.mapKeys(this, (value, key) => _.snakeCase(key));
    }

    static add(metadata) {
      return schemaValidate(new this(), metadata)
        .then(sectorValidate)
        .then(buildKeyStore)
        .then(register);
    }

    static remove(id) {
      cache.delete(id);
      return this.adapter.destroy(id);
    }

    static purge() {
      cache.clear();
    }

    static find(id) {
      if (cache.has(id)) {
        return Promise.resolve(cache.get(id));
      }

      return this.adapter.find(id).then((properties) => {
        if (properties) {
          return this.add(properties);
        }
        return undefined;
      });
    }

  }

  return Client;
};
