import RestModel from 'discourse/models/rest';
import ResultSet from 'discourse/models/result-set';

let _identityMap;

// You should only call this if you're a test scaffold
function flushMap() {
  _identityMap = {};
}

function storeMap(type, id, obj) {
  if (!id) { return; }

  _identityMap[type] = _identityMap[type] || {};
  _identityMap[type][id] = obj;
}

function fromMap(type, id) {
  const byType = _identityMap[type];
  if (byType) { return byType[id]; }
}

function removeMap(type, id) {
  const byType = _identityMap[type];
  if (byType) { delete byType[id]; }
}

function findAndRemoveMap(type, id) {
  const byType = _identityMap[type];
  if (byType) {
    const result = byType[id];
    delete byType[id];
    return result;
  }
}

flushMap();

export default Ember.Object.extend({
  pluralize(thing) {
    return thing + "s";
  },

  findAll(type) {
    const self = this;
    return this.adapterFor(type).findAll(this, type).then(function(result) {
      return self._resultSet(type, result);
    });
  },

  // Mostly for legacy, things like TopicList without ResultSets
  findFiltered(type, findArgs) {
    const self = this;
    return this.adapterFor(type).find(this, type, findArgs).then(function(result) {
      return self._build(type, result);
    });
  },

  find(type, findArgs) {
    const self = this;
    return this.adapterFor(type).find(this, type, findArgs).then(function(result) {
      if (typeof findArgs === "object") {
        return self._resultSet(type, result);
      } else {
        return self._hydrate(type, result[Ember.String.underscore(type)], result);
      }
    });
  },

  refreshResults(resultSet, type, url) {
    const self = this;
    return Discourse.ajax(url).then(function(result) {
      const typeName = Ember.String.underscore(self.pluralize(type)),
            content = result[typeName].map(obj => self._hydrate(type, obj, result));
      resultSet.set('content', content);
    });
  },

  appendResults(resultSet, type, url) {
    const self = this;

    return Discourse.ajax(url).then(function(result) {
      const typeName = Ember.String.underscore(self.pluralize(type)),
            totalRows = result["total_rows_" + typeName] || result.get('totalRows'),
            loadMoreUrl = result["load_more_" + typeName],
            content = result[typeName].map(obj => self._hydrate(type, obj, result));

      resultSet.setProperties({ totalRows, loadMoreUrl });
      resultSet.get('content').pushObjects(content);

      // If we've loaded them all, clear the load more URL
      if (resultSet.get('length') >= totalRows) {
        resultSet.set('loadMoreUrl', null);
      }
    });
  },

  update(type, id, attrs) {
    return this.adapterFor(type).update(this, type, id, attrs, function(result) {
      if (result && result[type] && result[type].id) {
        const oldRecord = findAndRemoveMap(type, id);
        storeMap(type, result[type].id, oldRecord);
      }
      return result;
    });
  },

  createRecord(type, attrs) {
    attrs = attrs || {};
    return !!attrs.id ? this._hydrate(type, attrs) : this._build(type, attrs);
  },

  destroyRecord(type, record) {
    return this.adapterFor(type).destroyRecord(this, type, record).then(function(result) {
      removeMap(type, record.get('id'));
      return result;
    });
  },

  _resultSet(type, result) {
    const typeName = Ember.String.underscore(this.pluralize(type)),
          content = result[typeName].map(obj => this._hydrate(type, obj, result)),
          totalRows = result["total_rows_" + typeName] || content.length,
          loadMoreUrl = result["load_more_" + typeName],
          refreshUrl = result['refresh_' + typeName];

    return ResultSet.create({ content, totalRows, loadMoreUrl, refreshUrl, store: this, __type: type });
  },

  _build(type, obj) {
    obj.store = this;
    obj.__type = type;
    obj.__state = obj.id ? "created" : "new";

    const klass = this.container.lookupFactory('model:' + type) || RestModel;
    const model = klass.create(obj);

    storeMap(type, obj.id, model);
    return model;
  },

  adapterFor(type) {
    return this.container.lookup('adapter:' + type) || this.container.lookup('adapter:rest');
  },

  _lookupSubType(subType, type, id, root) {

    // cheat: we know we already have categories in memory
    // TODO: topics do their own resolving of `category_id`
    // to category. That should either respect this or be
    // removed.
    if (subType === 'category' && type !== 'topic') {
      return Discourse.Category.findById(id);
    }

    const pluralType = this.pluralize(subType);
    const collection = root[this.pluralize(subType)];
    if (collection) {
      const hashedProp = "__hashed_" + pluralType;
      let hashedCollection = root[hashedProp];
      if (!hashedCollection) {
        hashedCollection = {};
        collection.forEach(function(it) {
          hashedCollection[it.id] = it;
        });
        root[hashedProp] = hashedCollection;
      }

      const found = hashedCollection[id];
      if (found) {
        const hydrated = this._hydrate(subType, found, root);
        hashedCollection[id] = hydrated;
        return hydrated;
      }
    }
  },

  _hydrateEmbedded(type, obj, root) {
    const self = this;
    Object.keys(obj).forEach(function(k) {
      const m = /(.+)\_id$/.exec(k);
      if (m) {
        const subType = m[1];
        const hydrated = self._lookupSubType(subType, type, obj[k], root);
        if (hydrated) {
          obj[subType] = hydrated;
          delete obj[k];
        }
      }
    });
  },

  _hydrate(type, obj, root) {
    if (!obj) { throw "Can't hydrate " + type + " of `null`"; }
    if (!obj.id) { throw "Can't hydrate " + type + " without an `id`"; }

    root = root || obj;

    // Experimental: If serialized with a certain option we'll wire up embedded objects
    // automatically.
    if (root.__rest_serializer === "1") {
      this._hydrateEmbedded(type, obj, root);
    }

    const existing = fromMap(type, obj.id);
    if (existing === obj) { return existing; }

    if (existing) {
      delete obj.id;
      const klass = this.container.lookupFactory('model:' + type) || RestModel;
      existing.setProperties(klass.munge(obj));
      return existing;
    }

    return this._build(type, obj);
  }
});

export { flushMap };
