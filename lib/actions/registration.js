'use strict';

const _ = require('lodash');
const bufferEqualsConstant = require('buffer-equals-constant');
const compose = require('koa-compose');
const crypto = require('crypto');
const uuid = require('node-uuid');

const bodyParser = require('../middlewares/selective_body');

const errors = require('../helpers/errors');
const parseBody = bodyParser('application/json');

module.exports = function registrationAction(provider) {
  return {
    post: compose([
      parseBody,
      function * registrationResponse() {
        const properties = {};

        Object.assign(properties, this.request.body, {
          client_id: uuid.v4(),
          client_secret: crypto.randomBytes(48).toString('base64'),
          client_secret_expires_at: 0,
          registration_access_token: crypto.randomBytes(48).toString('base64'),
        });

        const client = yield provider.addClient(properties);
        const dumpable = _.mapKeys(client, (value, key) => _.snakeCase(key));
        yield provider.get('Client').adapter.upsert(client.clientId, dumpable);

        const response = Object.assign({
          registration_client_uri: this.oidc.urlFor('registration_client', {
            clientId: properties.client_id,
          }),
        }, dumpable);

        this.body = response;
        this.status = 201;
      },
    ]),

    get: compose([

      function * validateAccessToken(next) {
        const client = yield provider.get('Client').find(this.params.clientId);

        this.assert(client, new errors.InvalidClientError());

        const valid = bufferEqualsConstant(
          new Buffer(client.registrationAccessToken || '', 'utf8'),
          new Buffer(this.oidc.bearer, 'utf8'),
          1024
        );

        this.assert(valid, new errors.InvalidTokenError());
        this.oidc.client = client;

        yield next;
      },

      function * clientResponse() {
        this.body = this.oidc.client.metadata();
        this.body.registration_client_uri = this.oidc.urlFor('registration_client', {
          clientId: this.params.clientId,
        });
      },
    ]),
  };
};
