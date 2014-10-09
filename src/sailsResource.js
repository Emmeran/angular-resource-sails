(function (angular) {

	var forEach = angular.forEach,
		extend = angular.extend,
		isObject = angular.isObject,
		isArray = angular.isArray,
		isFunction = angular.isFunction;

	angular.module('sailsResource', []).factory('sailsResource', ['$rootScope', '$window', '$log', '$q', resourceFactory]);

	function resourceFactory($rootScope, $window, $log, $q) {

		var DEFAULT_ACTIONS = {
			'get': {method: 'GET'},
			'save': {method: 'POST'},
			'query': {method: 'GET', isArray: true},
			'remove': {method: 'DELETE'},
			'delete': {method: 'DELETE'}
		};

		var DEFAULT_OPTIONS = {
			// Sails lets you set a prefix, such as '/api'
			prefix: '',
			// When verbose, socket updates go to the console
			verbose: false,
			// Set a specific websocket, used for testing
			socket: null,
			// Set a specific origin, used for testing
			origin: null
		};

		var MESSAGES = {
			// resource
			created: '$sailsResourceCreated',
			updated: '$sailsResourceUpdated',
			destroyed: '$sailsResourceDestroyed',
			messaged: '$sailsResourceMessaged',

			//socket
			connected: '$sailsConnected',
			disconnected: '$sailsDisconnected',
			reconnected: '$sailsReconnected',
			reconnecting: '$sailsReconnecting',
			socketError: '$sailsSocketError'
		};

		var origin = $window.location.origin;
		var socket = $window.io.connect(origin);

		socket.on('connect', function () {
			$rootScope.$apply(function () {
				$rootScope.$broadcast(MESSAGES.connected);
			});
		});

		socket.on('disconnect', function () {
			$rootScope.$apply(function () {
				$rootScope.$broadcast(MESSAGES.disconnected);
			});
		});

		socket.on('reconnect', function () {
			$rootScope.$apply(function () {
				$rootScope.$broadcast(MESSAGES.reconnected);
			});
		});

		socket.on('reconnecting', function (timeDisconnected, reconnectCount) {
			$rootScope.$apply(function () {
				$rootScope.$broadcast(MESSAGES.reconnecting, {
					timeDisconnected: timeDisconnected,
					reconnectCount: reconnectCount
				});
			});
		});

		socket.on('error', function (error) {
			$rootScope.$apply(function () {
				$rootScope.$broadcast(MESSAGES.socketError, error);
			});
		});

		return function (model, actions, options) {

			if (typeof model != 'string' || model.length == 0) {
				throw 'Model name is required';
			}

			model = model.toLowerCase(); // sails always sends models lowercase
			actions = extend({}, DEFAULT_ACTIONS, actions);
			options = extend({}, DEFAULT_OPTIONS, options);

			// Ensure prefix starts with forward slash
			if (options.prefix && options.prefix.charAt(0) != '/') {
				options.prefix = '/' + options.prefix;
			}

			// Caching
			var cache = {};
			// TODO implement cache clearing?

			function removeFromCache(id) {
				delete cache[id];
				// remove this item in all known lists
				forEach(cache, function (cacheItem) {
					if (isArray(cacheItem)) {
						var foundIndex = null;
						forEach(cacheItem, function (item, index) {
							if (item.id == id) {
								foundIndex = index;
							}
						});
						if (foundIndex != null) {
							cacheItem.splice(foundIndex, 1);
						}
					}
				});
			}

			// Resource constructor
			function Resource(value) {
				copyAndClear(value || {}, this);
			}

			function handleRequest(item, params, action, success, error) {
				if (isFunction(params)) {
					error = success;
					success = params;
					params = {};
				}

				if (action.method == 'GET') {

					// cache key is params for lists, id for items
					var key = action.isArray ? JSON.stringify(params || {}) : params.id;

					// pull out of cache if available, otherwise create new instance
					item = action.isArray ? cache[key] || [] : cache[params.id] || new Resource({id: params.id});

					if (action.cache) {
						cache[key] = item; // store item in cache
					}

					return retrieveResource(item, params, action, success, error);
				}
				else if (action.method == 'POST' || action.method == 'PUT') { // Update individual instance of model
					createOrUpdateResource(item, params, action, success, error);
				}
				else if (action.method == 'DELETE') { // Delete individual instance of model
					deleteResource(item, params, action, success, error);
				}
			}

			function handleResponse(item, data, action, deferred, delegate) {
				action = action || {};
				$rootScope.$apply(function () {
					item.$resolved = true;

					if (data.error) {
						$log.error(data);
						deferred.reject(data.error, item, data);
					}
					else if (!isArray(item) && isArray(data) && data.length != 1) {
						// This scenario occurs when GET is done without an id and Sails returns an array. Since the cached
						// item is not an array, only one item should be found or an error is thrown.
						var errorMessage = (data.length ? 'Multiple' : 'No') +
							' items found while performing GET on a singular Resource; did you mean to do a query?';

						$log.error(errorMessage);
						deferred.reject(errorMessage, item, data);
					}
					else {
						// converting single array to single item
						if (!isArray(item) && isArray(data)) data = data[0];

						if (isFunction(action.transformResponse)) data = action.transformResponse(data);
						if (isFunction(delegate)) delegate(data);
						deferred.resolve(item);
					}
				});
			}

			function attachPromise(item, success, error) {
				var deferred = $q.defer();
				item.$promise = deferred.promise;
				item.$promise.then(success);
				item.$promise.catch(error);
				item.$resolved = false;
				return deferred;
			}

			function retrieveResource(item, params, action, success, error) {
				var deferred = attachPromise(item, success, error);
				var url = options.prefix + '/' + model + (params && params.id ? '/' + params.id : '') + createQueryString(params);
				socket.get(url, function (response) {
					handleResponse(item, response, action, deferred, function (data) {
						if (isArray(item)) { // empty the list and update with returned data
							while (item.length) item.pop();
							forEach(data, function (responseItem) {
								responseItem = new Resource(responseItem);
								responseItem.$resolved = true;
								item.push(responseItem); // update list
							});
						}
						else {
							copyWithPromise(data, item); // update item
						}
					});
				});
				return item;
			}

			function createOrUpdateResource(item, params, action, success, error) {
				var deferred = attachPromise(item, success, error);

				// prep data
				var transformedData;
				if (isFunction(action.transformRequest)) {
					transformedData = JSON.parse(action.transformRequest(item));
				}

				// prevents prototype functions being sent
				var data = copyAndClear(transformedData || item, {});

				var url = options.prefix + '/' + model + (data.id ? '/' + data.id : '') + createQueryString(params);

				// when Resource has id use PUT, otherwise use POST
				var method = item.id ? 'put' : 'post';

				socket[method](url, data, function (response) {
					handleResponse(item, response, action, deferred, function (data) {
						copyWithPromise(data, item);
						$rootScope.$broadcast(method == 'put' ? MESSAGES.updated : MESSAGES.created, {
							model: model,
							id: data.id,
							data: data
						});
					});
				});
			}

			function deleteResource(item, params, action, success, error) {
				var deferred = attachPromise(item, success, error);

				var url = options.prefix + '/' + model + '/' + item.id + createQueryString(params);
				socket.delete(url, function (response) {
					handleResponse(item, response, action, deferred, function () {
						removeFromCache(item.id);
						$rootScope.$broadcast(MESSAGES.destroyed, {model: model, id: item.id});
						// leave local instance unmodified
					});
				});
			}

			function socketUpdateResource(message) {
				forEach(cache, function (cacheItem, key) {
					if (isArray(cacheItem)) {
						forEach(cacheItem, function (item) {
							if (item.id == message.id) {
								if (needsPopulate(message.data, item)) { // go to server for updated data
									retrieveResource(item, {id: item.id});
								}
								else {
									copyWithPromise(message.data, item);
								}
							}
						});
					}
					else if (key == message.id) {
						if (needsPopulate(message.data, cacheItem)) { // go to server for updated data
							retrieveResource(cacheItem, {id: cacheItem.id});
						}
						else {
							copyWithPromise(message.data, cacheItem);
						}
					}
				});
			}

			function socketCreateResource(message) {
				cache[message.id] = new Resource(message.data);
				// when a new item is created we have no way of knowing if it belongs in a cached list,
				// this necessitates doing a server fetch on all known lists
				// TODO does this make sense?
				forEach(cache, function (cacheItem, key) {
					if (isArray(cacheItem)) {
						retrieveResource(cacheItem, JSON.parse(key));
					}
				});
			}

			function socketDeleteResource(message) {
				removeFromCache(message.id);
			}

			// Add each action to the Resource or its prototype
			forEach(actions, function (action, name) {
				// fill in default action options
				action = extend({}, {cache: true, isArray: false}, action);
				// instance methods added to prototype with $ prefix
				var isInstanceMethod = /^(POST|PUT|PATCH|DELETE)$/i.test(action.method);
				var addTo = isInstanceMethod ? Resource.prototype : Resource;
				var actionName = isInstanceMethod ? '$' + name : name;

				addTo[actionName] = function (params, success, error) {
					var self = this;
					if (action.fetchAfterReconnect) {
						// let angular-resource-sails refetch important data after
						// a server disconnect then reconnect happens
						socket.on('reconnect', function () {
							$rootScope.$broadcast();
							handleRequest(self, params, action, success, error);
						});
					}

					return handleRequest(this, params, action, success, error);
				};
			});

			// Subscribe to changes
			socket.on(model, function (message) {
				if (options.verbose) {
					$log.log('sailsResource received \'' + model + '\' message: ', message);
				}
				var messageName = null;
				$rootScope.$apply(function () {
					switch (message.verb) {
						case 'updated':
							socketUpdateResource(message);
							messageName = MESSAGES.updated;
							break;
						case 'created':
							socketCreateResource(message);
							messageName = MESSAGES.created;
							break;
						case 'destroyed':
							socketDeleteResource(message);
							messageName = MESSAGES.destroyed;
							break;
						case 'messaged':
							messageName = MESSAGES.messaged;
							break;
					}
					$rootScope.$broadcast(messageName, extend({model: model}, message));
				});
			});

			return Resource;
		};
	}

	/**
	 * As of Sails 0.10.4 models with associations will not be populated in socket update data. This function detects
	 * this scenario, i.e. the dst[key] (current value) is an object, but the src[key] (updated value) is an id.
	 * Ideally this function will stop returning true if/when Sails addresses this issue as both dst and src will
	 * contain an object.
	 */
	function needsPopulate(src, dst) {
		for (var key in src) {
			if (src.hasOwnProperty(key) && isObject(dst[key]) && !isObject(src[key])) {
				return true;
			}
		}
		return false;
	}

	/**
	 * Deep copies and removes view properties
	 */
	function copyAndClear(src, dst) {
		dst = dst || (isArray(src) ? [] : {});

		forEach(dst, function (value, key) {
			delete dst[key];
		});

		for (var key in src) {
			if (src.hasOwnProperty(key) && key.charAt(0) !== '$') {
				var prop = src[key];
				dst[key] = isObject(prop) ? copyAndClear(prop) : prop;
			}
		}

		return dst;
	}

	function copyWithPromise(src, dst){
		var promise = dst.$promise;
		var resolved = dst.$resolved;

		angular.copy(src, dst);

		dst.$promise = promise;
		dst.$resolved = resolved;
	}

	/**
	 * Create a query-string out of a set of parameters.
	 */
	function createQueryString(params) {
		var qs = [];
		if (params) {
			qs.push('?');
			forEach(params, function (value, key) {
				if (key == 'id') return;
				qs.push(key + '=' + value);
				qs.push('&');
			});
			qs.pop(); // remove last &
		}
		return qs.join('');
	}

})(window.angular);