(function(angular) {
    angular.module('sailsResource', [])
        .factory('sailsResource', ['$rootScope', '$window', function ($rootScope, $window) {

            var $resourceMinErr = angular.$$minErr('$resource');

            return function (options) {

                if((typeof options == 'string' && options.length == 0) || !options.model || options.model.length == 0) {
                    throw $resourceMinErr('badargs', 'Model name is required');
                }

                // Options
                var model;
                if (typeof options == 'string') {
                    model = options;
                }
                else if (typeof options == 'object' && options.model) {
                    model = options.model;
                }

                var origin = options.origin || $window.location.origin;
                var socket = options.socket || $window.io.connect(origin);
                var cache = {};

                // Resource constructor
                function Resource(id, item) {
                    this.id = id; // required
                    if (item) {
                        angular.copy(item, this); // copy all properties if we're wrapping
                    }
                }

                // Retrieve list of models
                Resource.query = function () {
                    var list = []; // empty list for now
                    socket.get('/' + model, function (response) {
                        $rootScope.$apply(function () {
                            angular.forEach(response, function (responseItem) {
                                list.push(new Resource(responseItem.id, responseItem)); // update list
                                cache[+responseItem.id] = responseItem;
                            });
                        });
                    });
                    return list;
                };

                // Retrieve individual instance of model
                Resource.get = function (id) {

                    // attempt to pull from cache
                    if (cache[+id]) {
                        // return cache[+id]; TODO should we use cache for this purpose? thinking no
                    }

                    var item = new Resource(id); // empty item for now
                    cache[+id] = item;

                    socket.get('/' + model + '/' + id, function (response) {
                        $rootScope.$apply(function () {
                            angular.copy(response, item); // update item
                        });
                    });
                    return item;
                };

                Resource.prototype = {

                    // Update individual instance of model
                    $save: function () {
                        var self = this;

                        if (!this.id) { // A new model, use POST
                            socket.post('/' + model, this, function(response) {
                                $rootScope.$apply(function () {
                                    angular.copy(response, self);
                                });
                            });
                        }
                        else { // An existing model, use PUT
                            socket.put('/' + model + '/' + this.id, this, function (response) {
                                $rootScope.$apply(function () {
                                    angular.copy(response, self);
                                });
                            });
                        }
                    },

                    // Delete individual instance of model
                    $delete: function () {
                        var self = this;
                        socket.delete('/' + model + '/' + this.id, function (response) {
                            $rootScope.$apply(function() {
                                angular.copy(response, self);
                            });
                        });
                    }
                };

                // subscribe to changes
                socket.on(model, function (message) {
                    if (message.verb == 'updated') {
                        var cachedItem = cache[+message.id];
                        if (cachedItem) {
                            $rootScope.$apply(function () {
                                angular.copy(message.data, cachedItem);
                            });
                        }
                    }
                    else if (message.verb == 'created') {
                        // TODO do we store this in our cache?
                        // If so, how do we get make use of it?
                        // Scenario: we query a list, but then a new item is created, we are told about it
                        // but there's currently no way to update that list
                        cache[+message.id] = message.data;
                    }
                    else if (message.verb == 'destroyed') {
                        cache[+message.id] = null;
                    }
                });

                return Resource;
            };
        }]);

})(window.angular);