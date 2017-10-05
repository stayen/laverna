/**
 * @module collections/modules/Module
 */
import _ from 'underscore';
import Radio from 'backbone.radio';

/**
 * Core collection module. The main purpose of this class is to
 * make it easier to fetch/save models or collections without writing
 * boilerplate code in every controller. It also allows to do these operations
 * with Radio requests.
 *
 * @class
 * @license MPL-2.0
 * @listens channel#findModel - find a model by its ID
 * @listens channel#find - fetch models from the database
 * @listens channel#saveModel - save a model
 * @listens channel#save - save a collection to the database
 * @listens channel#saveModelObject - create a model from
 * a key=>value object and save it
 * @listens channel#saveFromArray - create models from an array
 * of objects and save them
 * @listens channel#remove - remove a model from the database
 */
export default class Module {

    /**
     * Backbone collection.
     *
     * @returns {Object}
     */
    get Collection() {
        return null;
    }

    /**
     * Backbone model.
     *
     * @returns {Object}
     */
    get Model() {
        return this.Collection.prototype.model;
    }

    /**
     * ID attribute used in a collection model.
     *
     * @returns {String}
     */
    get idAttribute() {
        return this.Model.prototype.idAttribute;
    }

    /**
     * Radio channel. collections/${Name}
     *
     * @returns {Object}
     */
    get channel() {
        return this.Collection.prototype.channel;
    }

    /**
     * App configs.
     *
     * @prop {Object}
     */
    get configs() {
        return Radio.request('collections/Configs', 'findConfigs');
    }

    constructor() {
        this.channel.reply({
            findModel       : this.findModel,
            find            : this.find,
            saveModel       : this.saveModel,
            save            : this.save,
            saveModelObject : this.saveModelObject,
            saveFromArray   : this.saveFromArray,
            remove          : this.remove,
        }, this);
    }

    /**
     * Find a model by its ID.
     *
     * @param {Object} options = {}
     * @param {String} options.id - id of a model
     * @param {String} [options.profileId] - profile ID
     * @returns {Promise}
     */
    findModel(options = {}) {
        // If id was not provided, return a model with default values
        if (!options[this.idAttribute]) {
            return Promise.resolve(new this.Model(null, {profileId: options.profileId}));
        }

        // The model exists in the collection
        const collModel = this.findCollectionModel(options);
        if (collModel) {
            return Promise.resolve(collModel);
        }

        // Instantiate a new model
        const model = new this.Model({
            [this.idAttribute] : options[this.idAttribute],
        }, {profileId: options.profileId});

        // Fetch and decrypt the model
        return model.fetch()
        .then(() => this.decryptModel(model));
    }

    /**
     * Try to find the model in this.collection.
     *
     * @returns {Object|Boolean}
     */
    findCollectionModel(options) {
        const profileId = options.profileId || 'default';
        if (!this.collection || this.collection.profileId !== profileId) {
            return false;
        }

        return this.collection.get(options[this.idAttribute]);
    }

    /**
     * Find all models.
     *
     * @param {Object} options = {}
     * @param {String} [options.conditions] - conditions by which models
     * will be filtered
     * @param {String} [options.profileId] - profile id
     * @returns {Promise}
     */
    find(options = {}) {
        return this.fetch(_.omit(options, 'conditions'))
        .then(collection => {
            if (options.filter || options.conditions) {
                collection.filterList(options);
            }

            if (collection.paginate && options.perPage !== 0) {
                collection.paginate();
            }

            return collection;
        });
    }

    /**
     * Fetch a collection and cache it in memory.
     * This method exists because decrypting a lot of models every time
     * a collection is fetched can be a very expensive operation.
     *
     * @param {Object} options
     * @returns {Promise} collection
     */
    fetch(options) {
        // If the collection is already cached, return its clone
        if (this.isCollectionEmpty(options)) {
            return Promise.resolve(this.collection.clone());
        }

        this.collection = new this.Collection(null, options);

        // Fetch and decrypt the collection
        return this.collection.fetch(options)
        .then(() => this.decryptCollection(this.collection))
        .then(() => this.collection.clone());
    }

    /**
     * Check if the collection is empty.
     *
     * @param {Object} options
     * @param {String} [options.profileId]
     * @returns {Boolean}
     */
    isCollectionEmpty(options) {
        const profileId = options.profileId || 'notes-db';
        return (
            this.collection && this.collection.length &&
            this.collection.profileId === profileId
        );
    }

    /**
     * Save a model.
     *
     * @param {Object} options
     * @param {Object} options.model - Backbone model
     * @param {Object} [options.data] - data that should be updated
     * (uses model.attributes if it's not provided)
     * @param {Boolean} [options.dontValidate]
     * @fires channel#update:model - after saving a model
     * @returns {Promise} - resolves with a model
     */
    saveModel(options) { //eslint-disable-line
        const {model} = options;
        const data    = options.data  || model.attributes;

        // Assume the model belongs to the user
        if (!data.sharedBy && !model.get('sharedBy')) {
            data.sharedBy = this.configs.username;
        }

        model.setEscape(data);
        let errors = null;
        if (!options.dontValidate) {
            errors = model.validate(model.attributes);
        }

        // Trigger invalid event if there are any validation errors
        if (errors) {
            model.trigger('invalid', {errors});
            return Promise.reject(`Validation error: ${errors}`);
        }

        // Encrypt the model and save
        return this.encryptModel(model)
        .then(() => model.save(model.getData(), {validate: false}))
        .then(() => {
            this.onSaveModel(model);
            this.channel.trigger('save:model', {model});
        });
    }

    /**
     * After saving a model, update/add it to this.collection.
     *
     * @param {Object} model
     */
    onSaveModel(model) {
        if (!this.collection) {
            return false;
        }

        const collModel = this.collection.get(model.id);

        if (collModel) {
            collModel.set(model.attributes);
        }
        else {
            this.collection.add(model);
        }
    }

    /**
     * Save all changes made in a collection.
     *
     * @param {Object} options = {}
     * @param {Object} options.collection - Backbone collection
     * @param {Object} [options.data] - with this every model in a collection
     * will be updated
     * @fires channel#save:collection - after saving a model
     * @returns {Promise}
     */
    save(options = {}) {
        const collection = options.collection || this.collection;
        const data       = options.data || {};
        const promises   = [];
        collection.each(model => promises.push(this.saveModel({model, data})));

        return Promise.all(promises)
        .then(() => this.channel.trigger('save:collection', {collection}));
    }

    /**
     * Create a model from a key=>value object and save it.
     *
     * @param {Object} options
     * @param {Object} options.data - an object with a model's values
     * @param {String} options.profileId - profile name
     * @param {Boolean} [options.dontValidate]
     * @fires collections/{Name}#save:object:{modelId}
     * @returns {Promise}
     */
    saveModelObject(options) {
        const model = new this.Model(options.data, {profileId: options.profileId});

        return this.decryptModel(model)
        .then(() => this.saveModel({model, dontValidate: options.dontValidate}))
        .then(() => this.channel.trigger(`save:object:${model.id}`, {model}))
        .then(() => model);
    }

    /**
     * Create models from an array of objects and save them.
     *
     * @param {Object} options
     * @param {Array} options.values - an array with key=>value objects
     * @param {String} options.profileId
     * @returns {Promise}
     */
    saveFromArray(options) {
        const promises = [];

        _.each(options.values, item => {
            const data = _.extend({data: item}, options);
            promises.push(this.saveModelObject(data));
        });

        return Promise.all(promises);
    }

    /**
     * Remove a model from database. It doesn't actually remove a model.
     * Instead, it changes a model's attributes to the default ones.
     *
     * @param {Object} options
     * @param {Object} [options.model] - Backbone.model
     * @param {Object} [options.id] - ID of a model
     * @fires channel#destroy:model
     * @returns {Promise}
     */
    remove(options) {
        const idAttr = this.idAttribute;
        const data   = {[idAttr]: options[idAttr] || options.model[idAttr]};
        const model  = new this.Model(data, {profileId: options.profileId});

        data.trash = 2;
        return this.saveModel({model, data})
        .then(() => this.channel.trigger('destroy:model', {model}));
    }

    /**
     * Check if a model can be encrypted and encryption is enabled.
     *
     * @param {Object} model = this.Model.prototype - Backbone model
     * @returns {Boolean}
     */
    isEncryptEnabled(model = this.Model.prototype) {
        // The model doesn't have label names that should be encrypted
        if (_.isUndefined(model.encryptKeys)) {
            return false;
        }

        const configs = Radio.request('collections/Configs', 'findConfigs');
        const backup  = {encrypt: configs.encryptBackup.encrypt || 0};

        // Encryption is enabled either in the current configs or backup
        return Number(configs.encrypt) === 1 || Number(backup.encrypt) === 1;
    }

    /**
     * Decrypt a model.
     *
     * @param {Object} model - Backbone model
     * @fires encrypt#decryptModel
     * @returns {Promise} resolves with a decrypted model
     */
    decryptModel(model) {
        if (!this.isEncryptEnabled(model)) {
            return Promise.resolve(model);
        }

        return Radio.request('models/Encryption', 'decryptModel', {model});
    }

    /**
     * Decrypt a collection.
     *
     * @param {Object} coll = this.collection - Backbone collection
     * @fires encrypt#decryptCollection
     * @returns {Promise} resolves with a decrypted collection
     */
    decryptCollection(coll = this.collection) {
        if (!this.isEncryptEnabled()) {
            return Promise.resolve(coll);
        }

        const collection = coll.fullCollection || coll;
        return Radio.request('models/Encryption', 'decryptCollection', {collection})
        .then(() => coll);
    }

    /**
     * Encrypt a model.
     *
     * @param {Object} model - Backbone model
     * @fires encrypt#encryptModel
     * @returns {Promise} resolves with an encrypted model
     */
    encryptModel(model) {
        if (!this.isEncryptEnabled(model)) {
            return Promise.resolve(model);
        }

        let username;

        // Encrypt "Edit" model with another user's public key
        if (model.storeName === 'edits') {
            username = model.get('username');
        }

        return Radio.request('models/Encryption', 'encryptModel', {model, username});
    }

}
