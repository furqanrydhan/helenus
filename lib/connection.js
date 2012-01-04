
var util = require('util'),
    thrift = require('thrift'),
    Cassandra = require('./cassandra/1.0/Cassandra'),    
    ttype = require('./cassandra/1.0/cassandra_types'),
    Row = require('./row'),
    ColumnFamily = require('./column_family');

/**
 * A No-Op function for default callbacks
 */
var NOOP = function(){};

/**
 * Default port for cassandra
 * @private
 */
var DEFAULT_PORT = 9160;

/**
 * Default host
 * @private
 */
var DEFAULT_HOST = 'localhost';

/**
 * Default Timeout
 * @private
 */
var DEFAULT_TIMEOUT = 4000;

/**
 * Creates a JS Error from a Cassndra Error
 * @param {Object} err The cassandra error eg: { name:'Exception', why:'Some Reason' }
 * @private
 */
function createError(err){
  var error = new Error(err.why);
  error.name = 'Helenus' + err.name;
  Error.captureStackTrace(error, createError);
  return error;
}

/**
 * The Cassandra Connection
 *
 * @param {Object} options The options for the connection defaults to:
     {
       port: 9160,
       host: 'localhost'
       user: null,
       password: null,
       keyspace: null,
       timeout: 1000
     }
 * @contructor
 */
var Connection = function(options){
  if(!options.port && options.host && options.host.indexOf(':') > -1){
    var split = options.host.split(':');
    options.host = split[0];
    options.port = split[1];
  }
  
  /**
   * The port to connect to
   */
  this.port = options.port || DEFAULT_PORT;

  /**
   * The host to connect to
   */
  this.host = options.host || DEFAULT_HOST;
  
  /**
   * The timeout for the connection
   */
  this.timeout = options.timeout || DEFAULT_TIMEOUT;
  
  /**
  * The username to authenticate with
  */
  this.user = options.user;
  
  /**
   * The password to connect with
   */
  this.password = options.password;
  
  /**
   * The keyspace to authenticate to
   */
  this.keyspace = options.keyspace;
  
  /**
   * Ready state of the client
   */
  this.ready = false;
};
util.inherits(Connection, process.EventEmitter);

/**
 * Connects to the cassandra cluster
 */
Connection.prototype.connect = function(callback){
  var self = this, timer;

  //set callback to a noop to prevent explosion
  callback = callback || NOOP;
  
  /**
   * Thrift Connection
   */
  this._connection = thrift.createConnection(this.host, this.port);

  //bubble up all errors
  this._connection.on('error', function(err){
    clearTimeout(timer);    
    self.emit('error', err);
  });
  
  //if we close we don't want ot be ready anymore, and emit it as an error
  this._connection.on('close', function(){
    clearTimeout(timer);
    self.ready = false;    
    self.emit('close');    
  });

  /**
   * Thrift Client
   */
  this._client = thrift.createClient(Cassandra, this._connection);
  
  /**
   * Handles what happens when we connect to the cassandra cluster
   *
   * @private
   * @param {Error} err A connection error with cassandra
   */
  function onAuthentication(err) {
    clearTimeout(timer);
    
    if (err){
      callback(err);
      self._connection.connection.destroy();
      return;
    }

    //set the state to ready
    self.ready = true;

    // if keyspace is specified, use that ks
    if (self.keyspace !== undefined){
      self.use(self.keyspace, callback);
    } else {
      callback();
    }
  }
  
  //after we connect, we authenticate
  this._connection.on('connect', function(err, msg){    
    if(err){            
      callback(err);
    } else {
      self.authenticate(onAuthentication);
    }
  });

  timer = setTimeout(function(){
    callback(createError({ name: 'TimeoutException', why: 'Connection Timed Out'}));
    self._connection.connection.destroy();  
  }, this.timeout);
};

/**
 * Sets the current keyspace
 *
 * @param {String} keyspace The keyspace to use
 */
Connection.prototype.use = function(keyspace, callback){
  var self = this;
  callback = callback || NOOP;
  
  function onKeyspace(err, definition){
    if (err) {
      callback(createError(err));
      return;
    }

    self._client.set_keyspace(keyspace, callback);
  }
  
  this._client.describe_keyspace(keyspace, onKeyspace);
};

/**
 * Authenticates the user
 */
Connection.prototype.authenticate = function(callback){
  callback = callback || NOOP;
  var self = this;

  if(this.user || this.password){
    var credentials = {username: this.user, password: this.password},
        authRequest = new ttype.AuthenticationRequest({ credentials: credentials });

    self._client.login(authRequest, function(err){
      if (err){
        callback(createError(err));  
      } else {
        callback(null);
      }
      
    });
  } else {
    callback();
  }
};

/**
 * Executes a command via the thrift connection
 * @param {String} command The command to execute
 * additional params are supplied to the command to be executed
 */
Connection.prototype.execute = function(){
  var args = Array.prototype.slice.apply(arguments),
      command = args.shift(),
      callback = args.pop();
  
  if(typeof callback !== 'function'){
    args.push(callback);
    callback = NOOP;
  }
  
  /**
   * Processes the return results of the query
   * @private
   */
  function onReturn(err, results){
    if(err){
      callback(createError(err));
    } else {
      callback(null, results);
    }
  }

  args.push(onReturn);
  
  this._client[command].apply(this._client, args);
};

/**
 * Executes a CQL Query Against the DB.
 * @param {String} cmd A string representation of the query: 'select %s, %s from MyCf where key=%s'
 * @param {arguments} args0...argsN An Array of arguments for the string ['arg0', 'arg1', 'arg2']
 * @param {Function} callback The callback function for the results
 */
Connection.prototype.cql = function(cmd, args, callback){  
  if(typeof callback !== 'function'){
    callback = NOOP;
  }
  
  args.unshift(cmd);
  
  var cql = new Buffer(util.format.apply(this, args));
  
  function onReturn(err, res){
    if (err){
      callback(err);
      return;
    }

    if(res.type === ttype.CqlResultType.ROWS){
      var rows = [], i = 0, rowlength = res.rows.length;
      for(; i < rowlength; i += 1){
        rows.push(new Row(res.rows[i], res.schema));
      }
      callback(null, rows);
    } else if(res.type === ttype.CqlResultType.INT){
      callback(null, res.num);
    } if (res.type === ttype.CqlResultType.VOID) {
      callback(null);
    }
  }
  this.execute('execute_cql_query', cql, ttype.Compression.NONE, onReturn);
};


/**
 * Closes the connection to the server
 */
Connection.prototype.close = function(){
  this._connection.end();
};
//export our client
module.exports = Connection;