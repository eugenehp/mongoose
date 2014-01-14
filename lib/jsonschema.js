/*!
 * Module dependencies.
 */

var EventEmitter = require('events').EventEmitter
  , VirtualType = require('./virtualtype')
  , utils = require('./utils')
  , mquery = require('mquery')
  , Query
  , Types

/**
 * JsonSchema constructor.
 *
 * ####Example:
 *
 *     var child = new JsonSchema({ name: String });
 *     var jsonschema = new JsonSchema({ name: String, age: Number, children: [child] });
 *     var Tree = mongoose.model('Tree', jsonschema);
 *
 *     // setting jsonschema options
 *     new JsonSchema({ name: String }, { _id: false, autoIndex: false })
 *
 * ####Options:
 *
 * - [autoIndex](/docs/guide.html#autoIndex): bool - defaults to true
 * - [bufferCommands](/docs/guide.html#bufferCommands): bool - defaults to true
 * - [capped](/docs/guide.html#capped): bool - defaults to false
 * - [collection](/docs/guide.html#collection): string - no default
 * - [id](/docs/guide.html#id): bool - defaults to true
 * - [_id](/docs/guide.html#_id): bool - defaults to true
 * - `minimize`: bool - controls [document#toObject](#document_Document-toObject) behavior when called manually - defaults to true
 * - [read](/docs/guide.html#read): string
 * - [safe](/docs/guide.html#safe): bool - defaults to true.
 * - [shardKey](/docs/guide.html#shardKey): bool - defaults to `null`
 * - [strict](/docs/guide.html#strict): bool - defaults to true
 * - [toJSON](/docs/guide.html#toJSON) - object - no default
 * - [toObject](/docs/guide.html#toObject) - object - no default
 * - [versionKey](/docs/guide.html#versionKey): bool - defaults to "__v"
 *
 * ####Note:
 *
 * _When nesting jsonschemas, (`children` in the example above), always declare the child jsonschema first before passing it into is parent._
 *
 * @param {Object} definition
 * @inherits NodeJS EventEmitter http://nodejs.org/api/events.html#events_class_events_eventemitter
 * @event `init`: Emitted after the jsonschema is compiled into a `Model`.
 * @api public
 */

function JsonSchema (obj, options) {
  if (!(this instanceof JsonSchema))
    return new JsonSchema(obj, options);

  this.paths = {};
  this.subpaths = {};
  this.virtuals = {};
  this.nested = {};
  this.inherits = {};
  this.callQueue = [];
  this._indexes = [];
  this.methods = {};
  this.statics = {};
  this.tree = {};
  this._requiredpaths = undefined;
  this.discriminatorMapping = undefined;
  this._indexedpaths = undefined;

  this.options = this.defaultOptions(options);

  // build paths
  if (obj) {
    this.add(obj);
  }

  // ensure the documents get an auto _id unless disabled
  var auto_id = !this.paths['_id'] && (!this.options.noId && this.options._id);
  if (auto_id) {
    this.add({ _id: {type: JsonSchema.ObjectId, auto: true} });
  }

  // ensure the documents receive an id getter unless disabled
  var autoid = !this.paths['id'] && (!this.options.noVirtualId && this.options.id);
  if (autoid) {
    this.virtual('id').get(idGetter);
  }
}

/*!
 * Returns this documents _id cast to a string.
 */

function idGetter () {
  if (this.$__._id) {
    return this.$__._id;
  }

  return this.$__._id = null == this._id
    ? null
    : String(this._id);
}

/*!
 * Inherit from EventEmitter.
 */

JsonSchema.prototype.__proto__ = EventEmitter.prototype;

/**
 * JsonSchema as flat paths
 *
 * ####Example:
 *     {
 *         '_id'        : JsonSchemaType,
 *       , 'nested.key' : JsonSchemaType,
 *     }
 *
 * @api private
 * @property paths
 */

JsonSchema.prototype.paths;

/**
 * JsonSchema as a tree
 *
 * ####Example:
 *     {
 *         '_id'     : ObjectId
 *       , 'nested'  : {
 *             'key' : String
 *         }
 *     }
 *
 * @api private
 * @property tree
 */

JsonSchema.prototype.tree;

/**
 * Returns default options for this jsonschema, merged with `options`.
 *
 * @param {Object} options
 * @return {Object}
 * @api private
 */

JsonSchema.prototype.defaultOptions = function (options) {
  if (options && false === options.safe) {
    options.safe = { w: 0 };
  }

  if (options && options.safe && 0 === options.safe.w) {
    // if you turn off safe writes, then versioning goes off as well
    options.versionKey = false;
  }

  options = utils.options({
      strict: true
    , bufferCommands: true
    , capped: false // { size, max, autoIndexId }
    , versionKey: '__v'
    , discriminatorKey: '__t'
    , minimize: true
    , autoIndex: true
    , shardKey: null
    , read: null
    // the following are only applied at construction time
    , noId: false // deprecated, use { _id: false }
    , _id: true
    , noVirtualId: false // deprecated, use { id: false }
    , id: true
//    , pluralization: true  // only set this to override the global option
  }, options);

  if (options.read) {
    options.read = mquery.utils.readPref(options.read);
  }

  return options;
}

/**
 * Adds key path / jsonschema type pairs to this jsonschema.
 *
 * ####Example:
 *
 *     var ToyJsonSchema = new JsonSchema;
 *     ToyJsonSchema.add({ name: 'string', color: 'string', price: 'number' });
 *
 * @param {Object} obj
 * @param {String} prefix
 * @api public
 */

JsonSchema.prototype.add = function add (obj, prefix) {
  prefix = prefix || '';
  var keys = Object.keys(obj);

  for (var i = 0; i < keys.length; ++i) {
    var key = keys[i];

    if (null == obj[key]) {
      throw new TypeError('Invalid value for jsonschema path `'+ prefix + key +'`');
    }

    if (utils.isObject(obj[key]) && (!obj[key].constructor || 'Object' == obj[key].constructor.name) && (!obj[key].type || obj[key].type.type)) {
      if (Object.keys(obj[key]).length) {
        // nested object { last: { name: String }}
        this.nested[prefix + key] = true;
        this.add(obj[key], prefix + key + '.');
      } else {
        this.path(prefix + key, obj[key]); // mixed type
      }
    } else {
      this.path(prefix + key, obj[key]);
    }
  }
};

/**
 * Reserved document keys.
 *
 * Keys in this object are names that are rejected in jsonschema declarations b/c they conflict with mongoose functionality. Using these key name will throw an error.
 *
 *      on, emit, _events, db, init, isNew, errors, jsonschema, options, modelName, collection, _pres, _posts, toObject
 *
 * _NOTE:_ Use of these terms as method names is permitted, but play at your own risk, as they may be existing mongoose document methods you are stomping on.
 *
 *      var jsonschema = new JsonSchema(..);
 *      jsonschema.methods.init = function () {} // potentially breaking
 */

JsonSchema.reserved = Object.create(null);
var reserved = JsonSchema.reserved;
reserved.on =
reserved.db =
reserved.init =
reserved.isNew =
reserved.errors =
reserved.jsonschema =
reserved.options =
reserved.modelName =
reserved.collection =
reserved.toObject =
reserved.emit =    // EventEmitter
reserved._events = // EventEmitter
reserved._pres = reserved._posts = 1 // hooks.js

/**
 * Gets/sets jsonschema paths.
 *
 * Sets a path (if arity 2)
 * Gets a path (if arity 1)
 *
 * ####Example
 *
 *     jsonschema.path('name') // returns a JsonSchemaType
 *     jsonschema.path('name', Number) // changes the jsonschemaType of `name` to Number
 *
 * @param {String} path
 * @param {Object} constructor
 * @api public
 */

JsonSchema.prototype.path = function (path, obj) {
  if (obj == undefined) {
    if (this.paths[path]) return this.paths[path];
    if (this.subpaths[path]) return this.subpaths[path];

    // subpaths?
    return /\.\d+\.?.*$/.test(path)
      ? getPositionalPath(this, path)
      : undefined;
  }

  // some path names conflict with document methods
  if (reserved[path]) {
    throw new Error("`" + path + "` may not be used as a jsonschema pathname");
  }

  // update the tree
  var subpaths = path.split(/\./)
    , last = subpaths.pop()
    , branch = this.tree;

  subpaths.forEach(function(sub, i) {
    if (!branch[sub]) branch[sub] = {};
    if ('object' != typeof branch[sub]) {
      var msg = 'Cannot set nested path `' + path + '`. '
              + 'Parent path `'
              + subpaths.slice(0, i).concat([sub]).join('.')
              + '` already set to type ' + branch[sub].name
              + '.';
      throw new Error(msg);
    }
    branch = branch[sub];
  });

  branch[last] = utils.clone(obj);

  this.paths[path] = JsonSchema.interpretAsType(path, obj);
  return this;
};

/**
 * Converts type arguments into Mongoose Types.
 *
 * @param {String} path
 * @param {Object} obj constructor
 * @api private
 */

JsonSchema.interpretAsType = function (path, obj) {
  if (obj.constructor && obj.constructor.name != 'Object')
    obj = { type: obj };

  // Get the type making sure to allow keys named "type"
  // and default to mixed if not specified.
  // { type: { type: String, default: 'freshcut' } }
  var type = obj.type && !obj.type.type
    ? obj.type
    : {};

  if ('Object' == type.constructor.name || 'mixed' == type) {
    return new Types.Mixed(path, obj);
  }

  if (Array.isArray(type) || Array == type || 'array' == type) {
    // if it was specified through { type } look for `cast`
    var cast = (Array == type || 'array' == type)
      ? obj.cast
      : type[0];

    if (cast instanceof JsonSchema) {
      return new Types.DocumentArray(path, cast, obj);
    }

    if ('string' == typeof cast) {
      cast = Types[cast.charAt(0).toUpperCase() + cast.substring(1)];
    } else if (cast && (!cast.type || cast.type.type)
                    && 'Object' == cast.constructor.name
                    && Object.keys(cast).length) {
      return new Types.DocumentArray(path, new JsonSchema(cast), obj);
    }

    return new Types.Array(path, cast || Types.Mixed, obj);
  }

  var name = 'string' == typeof type
    ? type
    : type.name;

  if (name) {
    name = name.charAt(0).toUpperCase() + name.substring(1);
  }

  if (undefined == Types[name]) {
    throw new TypeError('Undefined type at `' + path +
        '`\n  Did you try nesting JsonSchemas? ' +
        'You can only nest using refs or arrays.');
  }

  return new Types[name](path, obj);
};

/**
 * Iterates the jsonschemas paths similar to Array#forEach.
 *
 * The callback is passed the pathname and jsonschemaType as arguments on each iteration.
 *
 * @param {Function} fn callback function
 * @return {JsonSchema} this
 * @api public
 */

JsonSchema.prototype.eachPath = function (fn) {
  var keys = Object.keys(this.paths)
    , len = keys.length;

  for (var i = 0; i < len; ++i) {
    fn(keys[i], this.paths[keys[i]]);
  }

  return this;
};

/**
 * Returns an Array of path strings that are required by this jsonschema.
 *
 * @api public
 * @return {Array}
 */

JsonSchema.prototype.requiredPaths = function requiredPaths () {
  if (this._requiredpaths) return this._requiredpaths;

  var paths = Object.keys(this.paths)
    , i = paths.length
    , ret = [];

  while (i--) {
    var path = paths[i];
    if (this.paths[path].isRequired) ret.push(path);
  }

  return this._requiredpaths = ret;
}

/**
 * Returns indexes from fields and jsonschema-level indexes (cached).
 *
 * @api private
 * @return {Array}
 */

JsonSchema.prototype.indexedPaths = function indexedPaths () {
  if (this._indexedpaths) return this._indexedpaths;

  return this._indexedpaths = this.indexes();
}

/**
 * Returns the pathType of `path` for this jsonschema.
 *
 * Given a path, returns whether it is a real, virtual, nested, or ad-hoc/undefined path.
 *
 * @param {String} path
 * @return {String}
 * @api public
 */

JsonSchema.prototype.pathType = function (path) {
  if (path in this.paths) return 'real';
  if (path in this.virtuals) return 'virtual';
  if (path in this.nested) return 'nested';
  if (path in this.subpaths) return 'real';

  if (/\.\d+\.|\.\d+$/.test(path) && getPositionalPath(this, path)) {
    return 'real';
  } else {
    return 'adhocOrUndefined'
  }
};

/*!
 * ignore
 */

function getPositionalPath (self, path) {
  var subpaths = path.split(/\.(\d+)\.|\.(\d+)$/).filter(Boolean);
  if (subpaths.length < 2) {
    return self.paths[subpaths[0]];
  }

  var val = self.path(subpaths[0]);
  if (!val) return val;

  var last = subpaths.length - 1
    , subpath
    , i = 1;

  for (; i < subpaths.length; ++i) {
    subpath = subpaths[i];

    if (i === last && val && !val.jsonschema && !/\D/.test(subpath)) {
      if (val instanceof Types.Array) {
        // StringJsonSchema, NumberJsonSchema, etc
        val = val.caster;
      } else {
        val = undefined;
      }
      break;
    }

    // ignore if its just a position segment: path.0.subpath
    if (!/\D/.test(subpath)) continue;

    if (!(val && val.jsonschema)) {
      val = undefined;
      break;
    }

    val = val.jsonschema.path(subpath);
  }

  return self.subpaths[path] = val;
}

/**
 * Adds a method call to the queue.
 *
 * @param {String} name name of the document method to call later
 * @param {Array} args arguments to pass to the method
 * @api private
 */

JsonSchema.prototype.queue = function(name, args){
  this.callQueue.push([name, args]);
  return this;
};

/**
 * Defines a pre hook for the document.
 *
 * ####Example
 *
 *     var toyJsonSchema = new JsonSchema(..);
 *
 *     toyJsonSchema.pre('save', function (next) {
 *       if (!this.created) this.created = new Date;
 *       next();
 *     })
 *
 *     toyJsonSchema.pre('validate', function (next) {
 *       if (this.name != 'Woody') this.name = 'Woody';
 *       next();
 *     })
 *
 * @param {String} method
 * @param {Function} callback
 * @see hooks.js https://github.com/bnoguchi/hooks-js/tree/31ec571cef0332e21121ee7157e0cf9728572cc3
 * @api public
 */

JsonSchema.prototype.pre = function(){
  return this.queue('pre', arguments);
};

/**
 * Defines a post for the document
 *
 * Post hooks fire `on` the event emitted from document instances of Models compiled from this jsonschema.
 *
 *     var jsonschema = new JsonSchema(..);
 *     jsonschema.post('save', function (doc) {
 *       console.log('this fired after a document was saved');
 *     });
 *
 *     var Model = mongoose.model('Model', jsonschema);
 *
 *     var m = new Model(..);
 *     m.save(function (err) {
 *       console.log('this fires after the `post` hook');
 *     });
 *
 * @param {String} method name of the method to hook
 * @param {Function} fn callback
 * @see hooks.js https://github.com/bnoguchi/hooks-js/tree/31ec571cef0332e21121ee7157e0cf9728572cc3
 * @api public
 */

JsonSchema.prototype.post = function(method, fn){
  return this.queue('on', arguments);
};

/**
 * Registers a plugin for this jsonschema.
 *
 * @param {Function} plugin callback
 * @param {Object} opts
 * @see plugins
 * @api public
 */

JsonSchema.prototype.plugin = function (fn, opts) {
  fn(this, opts);
  return this;
};

/**
 * Adds an instance method to documents constructed from Models compiled from this jsonschema.
 *
 * ####Example
 *
 *     var jsonschema = kittyJsonSchema = new JsonSchema(..);
 *
 *     jsonschema.method('meow', function () {
 *       console.log('meeeeeoooooooooooow');
 *     })
 *
 *     var Kitty = mongoose.model('Kitty', jsonschema);
 *
 *     var fizz = new Kitty;
 *     fizz.meow(); // meeeeeooooooooooooow
 *
 * If a hash of name/fn pairs is passed as the only argument, each name/fn pair will be added as methods.
 *
 *     jsonschema.method({
 *         purr: function () {}
 *       , scratch: function () {}
 *     });
 *
 *     // later
 *     fizz.purr();
 *     fizz.scratch();
 *
 * @param {String|Object} method name
 * @param {Function} [fn]
 * @api public
 */

JsonSchema.prototype.method = function (name, fn) {
  if ('string' != typeof name)
    for (var i in name)
      this.methods[i] = name[i];
  else
    this.methods[name] = fn;
  return this;
};

/**
 * Adds static "class" methods to Models compiled from this jsonschema.
 *
 * ####Example
 *
 *     var jsonschema = new JsonSchema(..);
 *     jsonschema.static('findByName', function (name, callback) {
 *       return this.find({ name: name }, callback);
 *     });
 *
 *     var Drink = mongoose.model('Drink', jsonschema);
 *     Drink.findByName('sanpellegrino', function (err, drinks) {
 *       //
 *     });
 *
 * If a hash of name/fn pairs is passed as the only argument, each name/fn pair will be added as statics.
 *
 * @param {String} name
 * @param {Function} fn
 * @api public
 */

JsonSchema.prototype.static = function(name, fn) {
  if ('string' != typeof name)
    for (var i in name)
      this.statics[i] = name[i];
  else
    this.statics[name] = fn;
  return this;
};

/**
 * Defines an index (most likely compound) for this jsonschema.
 *
 * ####Example
 *
 *     jsonschema.index({ first: 1, last: -1 })
 *
 * @param {Object} fields
 * @param {Object} [options]
 * @api public
 */

JsonSchema.prototype.index = function (fields, options) {
  options || (options = {});

  if (options.expires)
    utils.expires(options);

  this._indexes.push([fields, options]);
  return this;
};

/**
 * Sets/gets a jsonschema option.
 *
 * @param {String} key option name
 * @param {Object} [value] if not passed, the current option value is returned
 * @api public
 */

JsonSchema.prototype.set = function (key, value, _tags) {
  if (1 === arguments.length) {
    return this.options[key];
  }

  switch (key) {
    case 'read':
      this.options[key] = mquery.utils.readPref(value, _tags)
      break;
    case 'safe':
      this.options[key] = false === value
        ? { w: 0 }
        : value
      break;
    default:
      this.options[key] = value;
  }

  return this;
}

/**
 * Gets a jsonschema option.
 *
 * @param {String} key option name
 * @api public
 */

JsonSchema.prototype.get = function (key) {
  return this.options[key];
}

/**
 * The allowed index types
 *
 * @static indexTypes
 * @receiver JsonSchema
 * @api public
 */

var indexTypes = '2d 2dsphere hashed text'.split(' ');

Object.defineProperty(JsonSchema, 'indexTypes', {
    get: function () { return indexTypes }
  , set: function () { throw new Error('Cannot overwrite JsonSchema.indexTypes') }
})

/**
 * Compiles indexes from fields and jsonschema-level indexes
 *
 * @api public
 */

JsonSchema.prototype.indexes = function () {
  'use strict';

  var indexes = []
    , seenJsonSchemas = []
  collectIndexes(this);
  return indexes;

  function collectIndexes (jsonschema, prefix) {
    if (~seenJsonSchemas.indexOf(jsonschema)) return;
    seenJsonSchemas.push(jsonschema);

    prefix = prefix || '';

    var key, path, index, field, isObject, options, type;
    var keys = Object.keys(jsonschema.paths);

    for (var i = 0; i < keys.length; ++i) {
      key = keys[i];
      path = jsonschema.paths[key];

      if (path instanceof Types.DocumentArray) {
        collectIndexes(path.jsonschema, key + '.');
      } else {
        index = path._index;

        if (false !== index && null != index) {
          field = {};
          isObject = utils.isObject(index);
          options = isObject ? index : {};
          type = 'string' == typeof index ? index :
            isObject ? index.type :
            false;

          if (type && ~JsonSchema.indexTypes.indexOf(type)) {
            field[prefix + key] = type;
          } else {
            field[prefix + key] = 1;
          }

          delete options.type;
          if (!('background' in options)) {
            options.background = true;
          }

          indexes.push([field, options]);
        }
      }
    }

    if (prefix) {
      fixSubIndexPaths(jsonschema, prefix);
    } else {
      jsonschema._indexes.forEach(function (index) {
        if (!('background' in index[1])) index[1].background = true;
      });
      indexes = indexes.concat(jsonschema._indexes);
    }
  }

  /*!
   * Checks for indexes added to subdocs using JsonSchema.index().
   * These indexes need their paths prefixed properly.
   *
   * jsonschema._indexes = [ [indexObj, options], [indexObj, options] ..]
   */

  function fixSubIndexPaths (jsonschema, prefix) {
    var subindexes = jsonschema._indexes
      , len = subindexes.length
      , indexObj
      , newindex
      , klen
      , keys
      , key
      , i = 0
      , j

    for (i = 0; i < len; ++i) {
      indexObj = subindexes[i][0];
      keys = Object.keys(indexObj);
      klen = keys.length;
      newindex = {};

      // use forward iteration, order matters
      for (j = 0; j < klen; ++j) {
        key = keys[j];
        newindex[prefix + key] = indexObj[key];
      }

      indexes.push([newindex, subindexes[i][1]]);
    }
  }
}

/**
 * Creates a virtual type with the given name.
 *
 * @param {String} name
 * @param {Object} [options]
 * @return {VirtualType}
 */

JsonSchema.prototype.virtual = function (name, options) {
  var virtuals = this.virtuals;
  var parts = name.split('.');
  return virtuals[name] = parts.reduce(function (mem, part, i) {
    mem[part] || (mem[part] = (i === parts.length-1)
                            ? new VirtualType(options, name)
                            : {});
    return mem[part];
  }, this.tree);
};

/**
 * Returns the virtual type with the given `name`.
 *
 * @param {String} name
 * @return {VirtualType}
 */

JsonSchema.prototype.virtualpath = function (name) {
  return this.virtuals[name];
};

/*!
 * Module exports.
 */

module.exports = exports = JsonSchema;

// require down here because of reference issues

/**
 * The various built-in Mongoose JsonSchema Types.
 *
 * ####Example:
 *
 *     var mongoose = require('mongoose');
 *     var ObjectId = mongoose.JsonSchema.Types.ObjectId;
 *
 * ####Types:
 *
 * - [String](#jsonschema-string-js)
 * - [Number](#jsonschema-number-js)
 * - [Boolean](#jsonschema-boolean-js) | Bool
 * - [Array](#jsonschema-array-js)
 * - [Buffer](#jsonschema-buffer-js)
 * - [Date](#jsonschema-date-js)
 * - [ObjectId](#jsonschema-objectid-js) | Oid
 * - [Mixed](#jsonschema-mixed-js)
 *
 * Using this exposed access to the `Mixed` JsonSchemaType, we can use them in our jsonschema.
 *
 *     var Mixed = mongoose.JsonSchema.Types.Mixed;
 *     new mongoose.JsonSchema({ _user: Mixed })
 *
 * @api public
 */

JsonSchema.Types = require('./jsonschema/index');

/*!
 * ignore
 */

Types = JsonSchema.Types;
Query = require('./query');
var ObjectId = exports.ObjectId = Types.ObjectId;

