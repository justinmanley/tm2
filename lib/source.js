var _ = require('underscore');
var carto = require('carto');
var crypto = require('crypto');
var fs = require('fs');
var path = require('path');
var util = require('util');
var url = require('url');
var mkdirp = require('mkdirp');
var sm = new (require('sphericalmercator'));
var yaml = require('js-yaml');
var tm = require('./tm');
var MBTiles = require('mbtiles');
var Bridge = require('tilelive-bridge');
var xray = require('tilelive-vector').xray;
var TileJSON = require('tilejson');
var tilelive = require('tilelive');
var style;
var CachingTileJSON = require('./cache');
var CachingBridge = require('./cache');
var mapnik = require('mapnik');
var mapnikref = require('mapnik-reference').version.latest;
var upload = require('mapbox-upload');
var progress = require('progress-stream');
var task = require('./task');
var https = require('https');
var zlib = require('zlib');

var defaults = {
    name:'',
    description:'',
    attribution:'',
    minzoom:0,
    maxzoom:6,
    center:[0,0,3],
    Layer:[],
    _prefs: {
        saveCenter: true,
        disabled: [],
        inspector: false,
        mapid: '',
        rev: ''
    }
};
var deflayer = {
    id:'',
    srs:'',
    description:'',
    fields: {},
    Datasource: {},
    properties: {
        'buffer-size': 8
    }
};

var cache = {};

module.exports = source;
tilelive.protocols['mapbox:'] = source;
tilelive.protocols['tmsource:'] = source;
tilelive.protocols['http:'] = source;
tilelive.protocols['https:'] = source;

source.defaults = defaults;
source.deflayer = deflayer;

var protocolIsValid = function (protocol) {
    return _(['tmsource:', 'mapbox:', 'http:', 'https:']).contains(protocol);
};

function source(arg, callback) {
    if ('string' !== typeof arg) {
        var id = url.format(arg);
        var uri = arg;
    } else {
        var id = arg;
        var uri = tm.parse(arg);
    }

    if (!protocolIsValid(uri.protocol))
        return callback(new Error('Invalid source protocol'));

    if (cache[id]) return callback(null, cache[id]);

    source.info(id, function(err, data) {
        if (err) return callback(err);
        try {
            data = source.normalize(data);
        } catch(err) {
            return callback(err);
        }
        source.toXML(data, function(err, xml) {
            if (err) return callback(err);
            source.refresh(data, xml, callback);
        });
    });
}

// Load or refresh the relevant source using specified data + xml.
source.refresh = function(data, xml, callback) {
    var id = data.id;
    var uri = tm.parse(data.id);
    var done = function(err, p) {
        if (err) return callback(err);
        cache[id] = cache[id] || p;
        cache[id].data = data;

        xray({
            source: cache[id],
            minzoom: data.minzoom,
            maxzoom: data.maxzoom,
            vector_layers: (data.vector_layers||[]).filter(function(l) {
                return data._prefs.disabled.indexOf(l.id) === -1
            })
        }, function(err, xraystyle) {
            if (err) return callback(err);
            cache[id].style = xraystyle;
            source.invalidate(id, function(err) {
                if (err) return callback(err);
                return callback(null, cache[id]);
            });
        });
    };
    if (xml) {
        var opts = {};
        opts.xml = xml;
        opts.base = !source.tmpid(id) && uri.dirname;
        var cb = CachingBridge(Bridge, tm.config().cache);
        return cache[id] ? cache[id].update(opts, done) : new cb(opts, done);
    } else {
        var ctj = CachingTileJSON(TileJSON, tm.config().cache);
        return cache[id] ? done(null, cache[id]) : new ctj({data:data}, done);
    }
};

// Writing.
source.save = function(data, callback) {
    var id = data.id;
    var uri = tm.parse(data.id);
    var perm = !source.tmpid(id);
    var remote = ['mapbox:', 'http:', 'https:'].indexOf(uri.protocol) >= 0;

    // "Soft" write for remote sources.
    if (remote) return source.info(id, function(err, info) {
        if (err) return callback(err);
        info._prefs = data._prefs || info._prefs;
        try {
            info = source.normalize(info);
        } catch(err) {
            return callback(err);
        }
        source.refresh(info, null, callback);
    });

    data = _(data).defaults(defaults);
    data._tmp = source.tmpid(id);
    try {
        data = source.normalize(data);
    } catch(err) {
        return callback(err);
    }

    // validate key info keys.
    var err = tilelive.verify(data, [
        'name',
        'description',
        'attribution',
        'center',
        'minzoom',
        'maxzoom'
    ]);
    // Exception for vector_layers length check. While sources are being
    // edited a vector_layers array of length 0 is ok.
    if (err && err.message !== 'vector_layers must be an array of layer objects') {
        return callback(err);
    }

    source.toXML(data, function(err, xml) {
        if (err) return callback(err);
        if (!perm) return source.refresh(data, xml, callback);

        var files = [];
        var filtered = tm.filterkeys(data, defaults);
        filtered.Layer = filtered.Layer.map(function(l) { return tm.filterkeys(l, deflayer) });
        files.push({
            basename: 'data.yml',
            data: yaml.dump(tm.sortkeys(filtered), null, 2)
        });
        files.push({ basename: 'data.xml', data: xml });

        tm.writefiles(uri.dirname, files, function(err) {
            if (err) return callback(err);
            source.refresh(data, xml, function(err, p) {
                if (err) return callback(err);
                source.thumbSave(id, path.join(uri.dirname,'.thumb.png'));
                callback(null, p);
            });
        });
    });
};

source.tmpid = function(id) {
    return id ? id === 'tmsource:///tmp' : 'tmsource:///tmp';
};

source.toXML = function(data, callback) {
    if (data.tiles) return callback();
    // Include params to be written to XML.
    var opts = [
        'name',
        'description',
        'attribution',
        'bounds',
        'center',
        'format',
        'minzoom',
        'maxzoom'
    ].reduce(function(memo, key) {
        if (key in data) memo[key] = data[key];
        return memo;
    }, {});
    opts.srs = tm.srs['900913'];
    opts.Layer = data.Layer.map(function(l) {
        l.srs = l.srs || tm.srs['900913'];
        l.name = l.id;
        return l;
    });
    opts.json = JSON.stringify({ vector_layers: data.vector_layers });

    try {
        var xml = new carto.Renderer().render(tm.sortkeys(opts));
    } catch(err) {
        return callback(err);
    }
    return callback(null, xml);
};

// Autodetect the extent (bounds) of a source.
source.extent = function(data) {
    var extent = (data.Layer||[]).reduce(function(memo, l) {
        // If SRS is not one of the known convertibles, skip.
        var srsname = tm.srsname[l.srs];
        if (['900913','WGS84'].indexOf(srsname) === -1) return memo;

        // Leave out any explicit extents. We want to try to detect here.
        var opts = _(l.Datasource).reduce(function(memo, val, key) {
            if (key !== 'extent') memo[key] = val;
            return memo;
        }, {});

        if (opts.file && !tm.absolute(opts.file)) opts.base = tm.parse(data.id).dirname;

        try {
            var extent = new mapnik.Datasource(opts).extent();
            if (srsname === '900913') extent = sm.convert(extent, 'WGS84');
            memo[0] = Math.max(-180, Math.min(extent[0], memo[0]));
            memo[1] = Math.max(-85.0511, Math.min(extent[1], memo[1]));
            memo[2] = Math.min(180, Math.max(extent[2], memo[2]));
            memo[3] = Math.min(85.0511, Math.max(extent[3], memo[3]));
        } catch(err) { console.error(err); }
        return memo;
    }, [Infinity,Infinity,-Infinity,-Infinity]);
    return extent[0] === Infinity ? [-180,-85.0511,180,85.0511] : extent;
};

// Initialize defaults and derived properties on source data.
source.normalize = function(data) {
    data = _(data).defaults(defaults);
    // Initialize deep defaults for _prefs, layers.
    data._prefs = _(data._prefs).defaults(defaults._prefs);
    data.Layer = data.Layer.map(function(l) {
        l = _(l).defaults(deflayer);
        // @TODO mapnikref doesn't distinguish between keys that belong in
        // layer properties vs. attributes...
        l.properties = _(l.properties).defaults(deflayer.properties);

        // Ensure required keys are met.
        var spec = mapnikref.datasources[l.Datasource.type];
        if (!spec) throw new Error(util.format('Invalid datasource type "%s" for layer "%s"', l.Datasource.type, l.id));

        // Ensure datasource keys are valid.
        l.Datasource = _(l.Datasource).reduce(function(memo, val, key) {
            if (key === 'type') memo[key] = val;
            if (key === 'layer') memo[key] = val;
            if (key in spec) memo[key] = val;
            // Set a default extent value for postgis based on the SRS.
            if (l.Datasource.type === 'postgis' && key === 'extent' && !val) {
                _(tm.srs).each(function(srs, id) {
                    if (l.srs !== srs) return;
                    memo[key] = tm.extent[id];
                });
            }
            return memo
        }, {});

        // Ensure required keys for datasource type are met.
        for (var key in spec) {
            if (!spec[key].required) continue;
            if (l.Datasource[key] !== '' && l.Datasource[key] !== undefined) continue;
            throw new Error(util.format('Missing required field "%s" (type=%s) for layer "%s"', key, l.id, l.Datasource.type));
        }
        return l;
    });
    // Format property to distinguish from imagery tiles.
    data.format = 'pbf';

    // Construct vector_layers info from layer properties if necessary.
    data.vector_layers = tm.parse(data.id).protocol === 'tmsource:'
        ? data.Layer.map(function(l) {
            var info = {};
            info.id = l.id;
            if ('description' in l) info.description = l.description;
            info.fields = [];
            var opts = _(l.Datasource).clone();

            if (opts.file && !tm.absolute(opts.file)) opts.base = tm.parse(data.id).dirname;

            var fields = new mapnik.Datasource(opts).describe().fields;
            info.fields = _(fields).reduce(function(memo, type, field) {
                memo[field] = l.fields[field] || type;
                return memo;
            }, {});
            return info;
        })
        : data.vector_layers;
    return data;
};

// Light read of style info.
source.info = function(id, callback) {
    var uri = tm.parse(id);

    if (!protocolIsValid(uri.protocol))
        return callback(new Error('Invalid source protocol'));

    var load = function(data, callback) {
        data.id = id;
        return callback(null, data);
    };

    var loadRemote = function () {
        var loaded = false;
        var url;

        if (uri.protocol === 'mapbox:') {
            var oauth = tm.db.get('oauth');
            if (!oauth) {
                var err = new Error('No active OAuth account');
                err.code = 'EOAUTH';
                return callback(err);
            }
            url = tm.config().mapboxtile + uri.pathname + '.json?secure=1&access_token='+oauth.accesstoken;
        } else {
            url = id;
        }

        if (tm.remote(id)) {
            load(_({}).defaults(tm.remote(id)), callback);
            loaded = true;
        }
        new TileJSON.get({
            uri: url,
            timeout: 5000
        }).asBuffer(function(err, data) {
            if (err) return callback(err);
            try { data = JSON.parse(data); }
            catch(err) { return callback(err); }
            if (!data.vector_layers) {
                tm.remote(id, undefined);
                return loaded || callback(new Error('Source ' + id + ' does not contain "vector_layers" key'));
            } else {
                tm.remote(id, data);
                return loaded || load(data, callback);
            }
        });
    };

    switch (uri.protocol) {
    case 'http:':
    case 'https:':
    case 'mapbox:':
        loadRemote();
        break;
    case 'tmsource:':
        var filepath = path.join(uri.dirname,'data.yml');
        fs.readFile(filepath, 'utf8', function(err, data) {
            if (err) return callback(err);
            try { data = yaml.load(data); }
            catch(err) { return callback(err); }

            // Might be valid yaml and yet not be an object.
            // Error out appropriately.
            if (!(data instanceof Object)) {
                return callback(new Error('Invalid YAML: ' + filepath));
            }

            return load(data, callback);
        });
        break;
    default:
        callback(new Error('Unsupported source protocol'));
        break;
    }
};

// Invalidate a source from the cache.
source.invalidate = function(id, callback) {
    if (!cache[id] || !cache[id]._mbtiles) return callback();
    cache[id]._mbtiles._clearCaches();
    cache[id]._mbtiles._db.exec('PRAGMA synchronous=OFF; DELETE FROM map; DELETE FROM images;', callback);
};

// Generate a hash based on source pertinent source info.
// Hash changes when significant portions of the source have changed.
source.toHash = function(id, callback, hashOnly) {
    source.info(id, function(err, info) {
        if (err) return callback(err);
        info = _(info).reduce(function(memo, val, key) {
            if (key === '_prefs') return memo;
            memo[key] = val;
            return memo;
        }, {});
        var hash = crypto.createHash('md5')
            .update(JSON.stringify(tm.sortkeys(info)))
            .digest('hex')
            .substr(0,8);
        if (hashOnly) return callback(null, hash);
        callback(null, path.join(tm.config().cache, 'export-' + hash + '.mbtiles'));
    });
};

// Grab mbtiles export info for a source. If no export exists and
// no export is in progress this will also kick off the export process.
source.mbtiles = function(id, force, callback) {
    source.toHash(id, function(err, file) {
        if (err) return callback(err);
        if (force) {
            fs.unlink(file, startExport);
        } else {
            fs.stat(file, startExport);
        }
    });

    function startExport(err, stat) {
        if (err && err.code !== 'ENOENT') return callback(err);

        // Export exists.
        if (stat) return callback(null, new task.Done(id, 'export', '/source.mbtiles?id=' + id, stat.size));

        // Check before setting creating task that there is no
        // active task. Remaining calls beyond this point are sync
        // ensuring that our task will be set without any gaps for
        // other tasks to sneak in!
        if (force) task.del();
        if (task.get() && task.get().id === id) return callback(null, task.get());
        if (task.get()) return callback(new Error('Active task in progress'));

        task.set(source.mbtilesExport(id));
        callback(null, task.get());
    }
};

source.mbtilesExport = function(id) {
    var tmp;
    var hash;
    var fsrc;
    var tsrc;
    var prog = progress({
        objectMode: true,
        time: 100
    });

    // Kick things off + return task object immediately.
    loadHash();
    return new task.Task(id, 'export', prog);

    function loadHash() {
        source.toHash(id, function(err, file) {
            if (err) return prog.emit('error', err);
            tmp = path.join(tm.config().tmp, path.basename(file));
            hash = file;
            loadf();
        });
    }

    function loadf() {
        source(id, function(err, f) {
            if (err) return prog.emit('error', err);
            fsrc = f;
            fsrc._cache = false;
            loadt();
        });
    }

    function loadt() {
        new MBTiles(tmp, function(err, t) {
            if (err) return prog.emit('error', err);
            tsrc = t;
            copy();
        });
    }

    function copy() {
        var read = tilelive.createReadStream(fsrc, {
            type: 'pyramid',
            bounds:fsrc.data.bounds || source.extent(fsrc.data)
        });
        var write = tilelive.createWriteStream(tsrc);
        read.on('error', function(err) { prog.emit('error', err); });
        write.on('error', function(err) { prog.emit('error', err); });
        read.on('length', prog.setLength);
        read.pipe(prog).pipe(write);
        write.on('stop', close);
    }

    function close() {
        tsrc.close(function(err) {
            if (err) return prog.emit('error', err);
            finish();
        });
    }

    function finish() {
        // Enable caching on source again.
        delete fsrc._nocache;
        fs.rename(tmp, hash, function(err) {
            if (err) return prog.emit('error', err);
            prog.emit('finished');
        });
    }
};

// Stream exported MBTiles on disk to dest.
source.toMBTiles = function(id, dest, callback) {
    callback = callback || function() {};
    if (!id) return callback(new Error('id is required.'));
    if (!dest) return callback(new Error('dest stream is required.'));

    source.toHash(id, function(err, file) {
        if (err) return callback(err);

        // If dest is an HTTP response object, set an appropriate header.
        if (dest.writable && dest.setHeader) {
            var basename = path.basename(id, '.tm2');
            dest.setHeader('content-disposition', 'attachment; filename="'+basename+'.mbtiles"');
            dest.setHeader('content-type', 'application/x-sqlite3');
        }

        try {
            var read = fs.createReadStream(file, { flags:'r', autoClose:true });
            read.pipe(dest);
            read.on('error', callback);
            read.on('end', callback);
            dest.on('error', callback);
        } catch(err) { callback(err); }
    });
};

source.upload = function(data, force, callback) {
    data.mapbox = data.mapbox ? data.mapbox : tm.config().mapboxauth;
    source.info(data.id, function(err, info) {
        if (err) return callback(err);
        source.toHash(data.id, function(err, hash){
            if (err) return callback(err);
            if (force) {
                delete info._prefs.rev;
                source.save(info, function(err) {
                    if (err) return callback(err);
                    startUpload(info, hash);
                });
            } else {
                startUpload(info, hash);
            }
        }, true);
    });

    function startUpload(info, hash) {
        // Nothing has changed since last upload.
        if ('s-'+hash === info._prefs.rev) {
            return callback(null, new task.Done(data.id, 'upload', '/mbtiles?id=' + data.id, 1, info._prefs.mapid));
        }

        // Use the existing mapid or create a new one.
        try {
            data.mapid = info._prefs.mapid || tm.mapid();
        } catch(err) {
            return callback(err);
        }

        // Check before setting creating task that there is no
        // active task. Remaining calls beyond this point are sync
        // ensuring that our task will be set without any gaps for
        // other tasks to sneak in!
        if (force) task.del();
        if (task.get() && task.get().id === data.id) return callback(null, task.get());
        if (task.get()) return callback(new Error('Active task in progress'));

        task.set(source.uploadStream(data, info, callback));
        callback(null, task.get());
    }
};

source.uploadStream = function(data, info, callback) {
    var fsrc;
    var prog = progress({
        objectMode: true,
        time: 100
    });

    // Kick things off + return task object immediately.
    loadf();
    return new task.Task(data.id, 'upload', prog);

    function loadf() {
        source(data.id, function(err, f) {
            if (err) return prog.emit('error', err);
            fsrc = f;
            fsrc._cache = false;
            copy();
        });
    }

    function copy() {
        var read = tilelive.createReadStream(fsrc, {
            type: 'pyramid',
            bounds:fsrc.data.bounds || source.extent(fsrc.data)
        });
        read.on('error', function(err) { prog.emit('error', err); });
        read.on('length', prog.setLength);
        var serialtiles = read.pipe(tilelive.serialize()).pipe(prog).pipe(zlib.Gzip());

        var uploadprog;
        try {
            uploadprog = upload({
                stream: serialtiles,
                account: data.oauth.account,
                accesstoken: data.oauth.accesstoken,
                mapid: data.mapid,
                mapbox: data.mapbox
            })
        } catch(err) {
            return prog.emit('error', err);
        }
        uploadprog
            .once('error', function(err) { prog.emit('error', err); })
            .once('finished', finish);
    }

    function finish() {
        // Enable caching on source again.
        delete fsrc._nocache;

        info._prefs.mapid = data.mapid;
        source.toHash(data.id, function(err, hash){
            if (err) return prog.emit('error', err);

            info._prefs.rev = 's-'+hash;
            source.save(info, function(err){
                if (err) return prog.emit('error', err);
                prog.emit('finished');
                prog.emit('mapid saved');
            });
        }, true);
    }
};

// Write source thumb
source.thumbSave = function(id, dest, callback) {
    callback = callback || function() {};

    var uri = tm.parse(id);
    dest = dest || path.join(uri.dirname,'.thumb.png');

    return source(id, function(err, s) {
        if (err) return callback(err);
        var style = s.style;
        var center = s.data.center;
        var xyz = sm.xyz([center[0],center[1],center[0],center[1]], center[2], false);
        style.getTile(center[2],xyz.minX,xyz.minY, function(err, buffer) {
            if (err) return callback(err);
            callback(null, buffer);
            // Save the thumb to disk.
            fs.writeFile(dest, buffer, function(err) {
                if (err) console.error(err);
            });
        });
    });
};

