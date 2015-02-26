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
//   BROBBOT_QUOTE_INIT_TIMEOUT=N - wait for N milliseconds for brain data to load from redis. (default 10000)
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
var STORE_PREFIX = 'user:';
var CACHE_PREFIX = 'cache-user:';
var CACHE_KEYS_PREFIX = 'cache-keys:';

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

function matches(searchStems, searchText, msg) {
  return searchText === '' || stemMatches(searchText, searchStems, msg) || textMatches(searchText, msg);
}

function hash(text) {
  return crypto.createHash('md5').update(text).digest('hex');
}

function start(robot) {
  robot.helpCommand('brobbot remember <user> <text>', 'remember most recent message from <user> containing <text>');
  robot.helpCommand('brobbot forget <user> <text>', 'forget most recent remembered message from <user> containing <text>');
  robot.helpCommand('brobbot quote [<user>] [<text>]', 'quote a random remembered message that is from <user> and/or contains <text>');
  robot.helpCommand('brobbot quotemash [<user>] [<text>]', 'quote some random remembered messages that are from <user> and/or contain <text>');
  robot.helpCommand('brobbot <text>|<user>mash', 'quote some random remembered messages that from <user> or contain <text>');

  function findStemMatches(keyPrefix, text, users, firstMatch) {
    var stems = uniqueStems(text);

    if (users) {
      keys = Q(_.map(users, function(user) {
        return keyPrefix + user.id;
      }));
    }
    else {
      keys = robot.brain.keys(keyPrefix);
    }

    return keys.then(function(keys) {
      var promises = _.map(keys, function(key) {
        var userId = key.replace(new RegExp('^' + keyPrefix), '');

        return robot.brain.hvals(key).then(function(messages) {
          if (firstMatch) {
            return [_.find(messages, matches.bind(this, stems, text))];
          }
          else {
            return _.filter(messages, matches.bind(this, stems, text));
          }
        },
        function() {
          return null;
        });
      });

      return Q.all(promises).then(function(results) {
        return _.flatten(_.compact(results));
      });
    });
  }

  function findFirstStemMatch(keyPrefix, text, users) {
    return findStemMatches(keyPrefix, text, users, true).then(function(messages) {
      return _.last(messages)
    });
  }

  function findStoredStemMatches(text, users) {
    return findStemMatches(STORE_PREFIX, text, users);
  }

  function findFirstStoredStemMatch(text, users) {
    return findFirstStemMatch(STORE_PREFIX, text, users);
  }

  function findFirstCachedStemMatch(text, users) {
    return findFirstStemMatch(CACHE_PREFIX, text, users);
  }

  function storeMessage(msg) {
    return ensureStoreSize(msg.userId, STORE_SIZE - 1).then(function() {
      return robot.brain.hset(STORE_PREFIX + msg.userId, msg.key, msg);
    });
  }

  function unstoreMessage(msg) {
    return robot.brain.hdel(STORE_PREFIX + msg.userId, msg.key);
  }

  function cacheMessage(msg) {
    return ensureCacheSize(msg.userId, CACHE_SIZE - 1).then(function() {
      return Q.all([
        robot.brain.hset(CACHE_PREFIX + msg.userId, msg.key, msg),
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
        return robot.brain.lpop(userKey).then(function(key) {
          return robot.brain.hdel(CACHE_PREFIX + userId, key);
        });
      }
    });
  }

  robot.respond(/remember ([^\s]+) (.*)/i, function(msg) {
    var username = msg.match[1];
    var text = msg.match[2];

    return robot.brain.usersForFuzzyName(username).then(function(users) {
      return findFirstCachedStemMatch(text, users).then(function(match) {
        if (match) {
          return Q.all([
            storeMessage(match),
            uncacheMessage(match)
          ]).then(function() {
            msg.send("remembering " + messageToString(match));
          });
        }
        else if (users.length === 0) {
          msg.send(userNotFoundMessage(username));
        }
        else {
          msg.send(notFoundMessage(text));
        }
      });
    });
  });

  robot.respond(/forget ([^\s]+) (.*)/i, function(msg) {
    var username = msg.match[1];
    var text = msg.match[2];

    return robot.brain.usersForFuzzyName(username).then(function(users) {
      return findFirstStoredStemMatch(text, users).then(function(match) {
        if (match) {
          return unstoreMessage(match).then(function() {
            msg.send("forgot " + messageToString(match));
          });
        }
        else if (users.length === 0) {
          msg.send(userNotFoundMessage(username));
        }
        else {
          msg.send(notFoundMessage(text));
        }
      });
    });
  });

  robot.respond(/quote($| )([^\s]*)?( (.*))?/i, function(msg) {
    var username = msg.match[2];
    var text = msg.match[4] || '';
    var users;

    if (username) {
      users = robot.brain.usersForFuzzyName(username);
    }
    else {
      users = Q(null);
    }

    return users.then(function(users) {
      if (username && (!users || users.length === 0)) {
        //username is optional, so include it in `text` if we don't find any users
        text = username + (text ? ' ' + text : '');
        users = null;
      }

      return findStoredStemMatches(text, users).then(function(matches) {
        if (matches && matches.length > 0) {
          message = randomItem(matches);
          msg.send(messageToString(message));
        }
        else if (users && users.length === 0) {
          msg.send(userNotFoundMessage(username));
        }
        else if (!text) {
          msg.send(emptyStoreMessage());
        }
        else {
          msg.send(notFoundMessage(text));
        }
      });
    });
  });

  robot.respond(/(quotemash( ([^\s]*))?( (.*))?)|((([^\s]+))mash)/i, function(msg) {
    var username = msg.match[3] || msg.match[8] || '';
    var text = msg.match[5] || '';
    var limit = 10;
    var users;

    if (username) {
      users = robot.brain.usersForFuzzyName(username);
    }
    else {
      users = Q(null);
    }

    return users.then(function(users) {
      if (!users || users.length === 0) {
        //username is optional, so include it in `text` if we don't find any users
        text = username + (text ? ' ' + text : '');
        users = null;
      }

      return findStoredStemMatches(text, users).then(function(matches) {
        if (matches && matches.length > 0) {
          msg.send.apply(msg, _.map(randomItems(matches, limit), messageToString));
        }
        else if (!text) {
          msg.send(emptyStoreMessage());
        }
        else {
          msg.send(notFoundMessage(text));
        }
      });
    });
  });

  robot.hear(/.*/, function(msg) {
    if (!msg.message.isAddressedToBrobbot) {
      return cacheMessage({
        text: msg.message.text,
        userId: msg.message.user.id,
        user: msg.message.user,
        key: hash(msg.message.text)
      });
    }
  });
}

module.exports = start;
