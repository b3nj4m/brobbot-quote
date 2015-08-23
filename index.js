// Description:
//   Remember messages and quote them back
//
// Dependencies:
//   underscore: ~1.7.0
//   natural: ~0.1.28
//   q: ~1.1.2
//
// Configuration:
//   BROBBOT_QUOTE_CACHE_SIZE=N - Cache the last N messages for each user for potential remembrance (default 25).
//   BROBBOT_QUOTE_STORE_SIZE=N - Remember at most N messages for each user (default 100).
//   BROBBOT_QUOTE_INIT_TIMEOUT=N - wait for N milliseconds for brain data to load from redis. (default 10000).
//   BROBBOT_QUOTE_SUBSTRING_MATCHING=true|false - whether to include substring matches when searching for quotes (default true).
//
// Author:
//   b3nj4m

var crypto = require('crypto');
var _ = require('underscore');
var natural = require('natural');
var Q = require('q');

var stemmer = natural.PorterStemmer;

var CACHE_SIZE = process.env.BROBBOT_QUOTE_CACHE_SIZE ? parseInt(process.env.BROBBOT_QUOTE_CACHE_SIZE) : 25;
var STORE_SIZE = process.env.BROBBOT_QUOTE_STORE_SIZE ? parseInt(process.env.BROBBOT_QUOTE_STORE_SIZE) : 100;
var INIT_TIMEOUT = process.env.BROBBOT_QUOTE_INIT_TIMEOUT ? parseInt(process.env.BROBBOT_QUOTE_INIT_TIMEOUT) : 10000;
var SUBSTRING_MATCHING = process.env.BROBBOT_QUOTE_SUBSTRING_MATCHING ? process.env.BROBBOT_QUOTE_SUBSTRING_MATCHING === 'true' : true;
var STORE_PREFIX = 'user:';
var STORE_KEYS_PREFIX = 'user-keys:';
var STORE_USER_IDS = 'user-ids';
var CACHE_USER_IDS = 'cache-user-ids';
var CACHE_PREFIX = 'cache-user:';
var CACHE_KEYS_PREFIX = 'cache-keys:';

function iterValues(iter) {
  var result = [];
  for (var val of iter) {
    result.push(val);
  }
  return result;
}

function uniqueStems(text) {
  return _.unique(stemmer.tokenizeAndStem(text));
}

var messageTmpl = _.template('<%= user.name %>: <%= text %>');

var userNotFoundTmpls = [
  "I don't know any <%= username %>",
  "<%= username %> is lame."
];
userNotFoundTmpls = _.map(userNotFoundTmpls, _.template);

var notFoundTmpls = [
  "I don't know anything about <%= text %>.",
  "Wat."
];
notFoundTmpls = _.map(notFoundTmpls, _.template);

function randomItem(list) {
  return list[_.random(list.length - 1)];
}

function findWithOrderedKeys(map, keys, predicate, context) {
  context = context || this;

  for (var i = 0; i < keys.length; i++) {
    if (predicate.call(context, map.get(keys[i]))) {
      return map.get(keys[i]);
    }
  }
}

//get random subset of items (mutates original list)
function randomItems(list, limit) {
  var messages = new Array(Math.min(list.length, limit));

  for (var i = 0; i < messages.length; i++) {
    messages[i] = list.splice(_.random(list.length - 1), 1)[0];
  }

  return messages;
}

function messageToString(message) {
  return messageTmpl(message);
}

function userNotFoundMessage(username) {
  return randomItem(userNotFoundTmpls)({username: username});
}

function notFoundMessage(text) {
  return randomItem(notFoundTmpls)({text: text});
}

function emptyStoreMessage() {
  return "I don't remember any quotes...";
}

function stemMatches(searchText, searchStems, msg) {
  //cache stems on message
  msg.stems = msg.stems || uniqueStems(msg.text);
  //require all stems to be present
  return searchStems.length > 0 && _.intersection(searchStems, msg.stems).length === searchStems.length;
}

function textMatches(searchText, msg) {
  return msg.text.toLowerCase().indexOf(searchText.toLowerCase()) > -1;
}

function isWords(text) {
  return /\b[\w]{2,}\b/.test(text);
}

var regexTest = new RegExp("^/.+/$");
var regexExtract = new RegExp("^/(.*)/$");

function isRegex(text) {
  return regexTest.test(text);
}

function regexMatches(text, msg) {
  var regex;
  try {
    regex = new RegExp(text.replace(regexExtract, '$1'));
    return regex.test(msg.text);
  }
  catch (err) {
    return false;
  }
}

function stringMatches(searchText, searchStems, msg) {
  return (isRegex(searchText) && regexMatches(searchText, msg)) || stemMatches(searchText, searchStems, msg) || ((SUBSTRING_MATCHING || !isWords(searchText)) && textMatches(searchText, msg));
}

function matches(username, userIds, searchStems, searchText, msg) {
  if (username === '' && searchText === '') {
    return true;
  }

  var userMatch = userIds && userIds.length > 0 && _.contains(userIds, msg.user.id);
  if (searchText === '' && userMatch) {
    return true;
  }

  if (searchText === '') {
    return stringMatches(username, searchStems, msg);
  }
  else {
    return userMatch && stringMatches(searchText, searchStems, msg);
  }
}

function hash(text) {
  return crypto.createHash('md5').update(text).digest('hex');
}

function handleFailure(msg, username, text, err) {
  if (err === 'USER_NOT_FOUND') {
    msg.send(userNotFoundMessage(username));
  }
  else if (text === '' && username === '') {
    msg.send(emptyStoreMessage());
  }
  else {
    msg.send(notFoundMessage(text || username));
  }
}

function start(robot) {
  robot.helpCommand('brobbot remember `user` `text`', 'remember most recent message from `user` containing `text`');
  robot.helpCommand('brobbot forget `user` `text`', 'forget most recent remembered message from `user` containing `text`');
  robot.helpCommand('brobbot quote [`user`] [`text`]', 'quote a random remembered message that is from `user` and/or contains `text`');
  robot.helpCommand('brobbot quotemash [`user`] [`text`]', 'quote some random remembered messages that are from `user` and/or contain `text`');
  robot.helpCommand('brobbot `user`mash', 'quote some random remembered messages that are from `user`');
  robot.helpCommand('brobbot `text`mash', 'quote some random remembered messages that contain `text`');
  robot.helpCommand('brobbot / `regex` /mash', 'quote some random remembered messages that matches `regex`');

  //migrate data to 4.0.0
  robot.brain.exists(STORE_USER_IDS).then(function(exists) {
    if (!exists) {
      return robot.brain.keys(STORE_PREFIX).then(function(keys) {
        return Q.all(_.map(keys, function(key) {
          return robot.brain.sadd(STORE_USER_IDS, key.replace(STORE_PREFIX, ''));
        }));
      });
    }
  });

  function findStemMatches(keyPrefix, userIdsKey, text, username, userRequired, firstMatch, keyListPrefix) {
    return robot.brain.usersForFuzzyName(username).then(function(users) {
      if (users.length === 0 && userRequired) {
        //require a matching user when both username and search text are given
        throw 'USER_NOT_FOUND';
      }

      var stems = uniqueStems(text || username);
      var userIds = _.pluck(users, 'id');

      var userKeys = _.map(users, function(user) {
        return keyPrefix + user.id;
      });

      var keys;
      if (userRequired) {
        keys = Q(userKeys);
      }
      else {
        keys = robot.brain.smembers(userIdsKey).then(function(ids) {
          var keys = _.map(ids, function(id) {
            return keyPrefix + id;
          });
          return _.unique(userKeys.concat(keys));
        });
      }

      //TODO return user along with match
      return keys.then(function(keys) {
        var promises = _.map(keys, function(key) {
          var userId = key.replace(new RegExp('^' + keyPrefix), '');

          return robot.brain.hgetall(key).then(function(messages) {
            var matchFn = matches.bind(this, username, userIds, stems, text);

            if (firstMatch && keyListPrefix) {
              return robot.brain.lgetall(keyListPrefix + userId).then(function(messageKeys) {
                if (messageKeys && messageKeys.length > 0) {
                  return [findWithOrderedKeys(messages, messageKeys, matchFn)];
                }
                else {
                  return _.filter(iterValues(messages.values()), matchFn);
                }
              });
            }
            else {
              return _.filter(iterValues(messages.values()), matchFn);
            }
          },
          function() {
            return null;
          });
        });

        return Q.all(promises).then(function(results) {
          return _.compact(_.flatten(results));
        });
      });
    }).then(function(messages) {
      if (messages.length === 0) {
        throw 'NO_MATCHES';
      }
      return messages;
    });
  }

  function findFirstStemMatch(keyPrefix, userIdsKey, text, username, userRequired, keyListPrefix) {
    return findStemMatches(keyPrefix, userIdsKey, text, username, userRequired, true, keyListPrefix).then(function(messages) {
      return _.first(messages);
    });
  }

  function findStoredStemMatches(text, username, userRequired) {
    return findStemMatches(STORE_PREFIX, STORE_USER_IDS, text, username, userRequired);
  }

  function findFirstStoredStemMatch(text, username, userRequired) {
    return findFirstStemMatch(STORE_PREFIX, STORE_USER_IDS, text, username, userRequired, STORE_KEYS_PREFIX);
  }

  function findFirstCachedStemMatch(text, username, userRequired) {
    return findFirstStemMatch(CACHE_PREFIX, CACHE_USER_IDS, text, username, userRequired, CACHE_KEYS_PREFIX);
  }

  function storeMessage(msg) {
    return ensureStoreSize(msg.userId, STORE_SIZE - 1).then(function() {
      return Q.all([
        robot.brain.hset(STORE_PREFIX + msg.userId, msg.key, msg),
        robot.brain.sadd(STORE_USER_IDS, msg.userId),
        storeQuotedMessage(msg)
      ]);
    });
  }

  function unstoreMessage(msg) {
    return Q.all([
      robot.brain.hdel(STORE_PREFIX + msg.userId, msg.key),
      unstoreQuotedMessage(msg)
    ]);
  }

  function ensureQuotedSize(userId, size) {
    var userKey = STORE_KEYS_PREFIX + userId;

    return robot.brain.llen(userKey).then(function(length) {
      if (length > size) {
        return robot.brain.lpop(userKey);
      }
    });
  }

  function storeQuotedMessage(msg) {
    return ensureQuotedSize(msg.userId, CACHE_SIZE - 1).then(function() {
      return robot.brain.lpush(STORE_KEYS_PREFIX + msg.userId, msg.key, msg);
    });
  }

  function unstoreQuotedMessage(msg) {
    return robot.brain.lrem(STORE_KEYS_PREFIX + msg.userId, msg.key);
  }

  function send(msg) {
    var messages = _.rest(_.toArray(arguments));
    msg.send.apply(msg, _.map(messages, messageToString));
    return Q.all(_.map(messages, storeQuotedMessage));
  }

  function cacheMessage(msg) {
    return ensureCacheSize(msg.userId, CACHE_SIZE - 1).then(function() {
      return Q.all([
        robot.brain.hset(CACHE_PREFIX + msg.userId, msg.key, msg),
        robot.brain.sadd(CACHE_USER_IDS, msg.userId),
        robot.brain.lpush(CACHE_KEYS_PREFIX + msg.userId, msg.key)
      ]);
    });
  }

  function uncacheMessage(msg) {
    return Q.all([
      robot.brain.hdel(CACHE_PREFIX + msg.userId, msg.key),
      robot.brain.lrem(CACHE_KEYS_PREFIX + msg.userId, msg.key)
    ]);
  }

  function removeRandomMessage(key) {
    return robot.brain.hkeys(key).then(function(keys) {
      return robot.brain.hdel(key, randomItem(keys));
    });
  }

  function ensureStoreSize(userId, size) {
    var userKey = STORE_PREFIX + userId;

    return robot.brain.hlen(userKey).then(function(length) {
      if (length > size) {
        return Q.all(_.times(length - size, removeRandomMessage.bind(this, userKey)));
      }
    });
  }

  function ensureCacheSize(userId, size) {
    var userKey = CACHE_KEYS_PREFIX + userId;

    return robot.brain.llen(userKey).then(function(length) {
      if (length > size) {
        return Q.all(_.times( length - size, function() {
          return robot.brain.rpop(userKey).then(function(key) {
            return robot.brain.hdel(CACHE_PREFIX + userId, key);
          });
        }));
      }
    });
  }

  robot.respond(/^remember ([^\s]+) (.*)/i, function(msg) {
    var username = msg.match[1] || '';
    var text = msg.match[2] || '';

    return findFirstCachedStemMatch(text, username, true).then(function(match) {
      return Q.all([
        storeMessage(match),
        uncacheMessage(match)
      ]).then(function() {
        msg.send("remembering " + messageToString(match));
      });
    }, handleFailure.bind(this, msg, username, text));
  });

  robot.respond(/^forget ([^\s]+) (.*)/i, function(msg) {
    var username = msg.match[1] || '';
    var text = msg.match[2] || '';

    return findFirstStoredStemMatch(text, username, true).then(function(match) {
      return unstoreMessage(match).then(function() {
        msg.send("forgot " + messageToString(match));
      });
    }, handleFailure.bind(this, msg, username, text));
  });

  robot.respond(/^quote($| )([^\s]*)?( (.*))?/i, function(msg) {
    var username = msg.match[2] || '';
    var text = msg.match[4] || '';

    return findStoredStemMatches(text, username).then(function(matches) {
      message = randomItem(matches);
      send(msg, message);
    }, handleFailure.bind(this, msg, username, text));
  });

  robot.respond(/^(quotemash( ([^\s]*))?( (.*))?)|((([^\s]+))mash)/i, function(msg) {
    var username = msg.match[3] || msg.match[8] || '';
    var text = msg.match[5] || '';
    var limit = 10;

    return findStoredStemMatches(text, username).then(function(matches) {
      send.apply(this, [msg].concat(randomItems(matches, limit)));
    }, handleFailure.bind(this, msg, username, text));
  });

  robot.hear(/.*/, function(msg) {
    if (!msg.message.isBrobbotCommand) {
      return cacheMessage({
        text: msg.message.text,
        userId: msg.message.user.id,
        user: msg.message.user,
        key: hash((new Date()).getTime().toString() + ':' + msg.message.text)
      });
    }
  });
}

module.exports = start;
