'use strict';

const MemoryAdapter = require('../adapters/memory_adapter');
const ConfigurationSchema = require('./configuration_schema');

class Configuration {
  constructor(config) {
    const schema = new ConfigurationSchema(config);
    Object.assign(this, schema);

    this.subjectTypes.forEach((type) => {
      /* istanbul ignore if */
      if (['public', 'pairwise'].indexOf(type) === -1) {
        throw new Error('only public and pairwise subjectTypes are supported');
      }
    });

    if (this.subjectTypes.indexOf('pairwise') !== -1 && !this.pairwiseSalt) {
      throw new Error(
        'pairwiseSalt must be configured when pairwise subjectType is to be supported');
    }

    if (!this.adapter) {
      this.adapter = MemoryAdapter;
    }
  }
}

module.exports = function getConfiguration(config) {
  return new Configuration(config);
};
