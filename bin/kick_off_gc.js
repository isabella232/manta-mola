#!/usr/bin/env node
// -*- mode: js -*-
// Copyright (c) 2012, Joyent, Inc. All rights reserved.

var assert = require('assert-plus');
var bunyan = require('bunyan');
var fs = require('fs');
var getopt = require('posix-getopt');
var lib = require('../lib');
var manta = require('manta');
var path = require('path');
var vasync = require('vasync');
var sys = require('sys');



///--- Global Objects

var NAME = 'mola';
var LOG = bunyan.createLogger({
        level: (process.env.LOG_LEVEL || 'info'),
        name: NAME,
        stream: process.stdout
});
var MANTA_CONFIG = (process.env.MANTA_CONFIG ||
                    '/opt/smartdc/common/etc/config.json');
var MANTA_CLIENT = manta.createClientFromFileSync(MANTA_CONFIG, LOG);
var MANTA_USER = MANTA_CLIENT.user;



///--- Global Strings

var MP = '/' + MANTA_USER + '/stor';
var BACKUP_DIR = MP + '/manatee_backups';
var MOLA_CODE_BUNDLE = (process.env.MOLA_CODE_BUNDLE ||
                        '/opt/smartdc/common/bundle/mola.tar.gz');
var GC_JOB_NAME = 'manta_gc';
var MANTA_GC_DIR = MP + '/manta_gc';
var MANTA_ASSET_DIR = MANTA_GC_DIR + '/assets';
var MOLA_ASSET_KEY = MANTA_ASSET_DIR + '/mola.tar.gz';
var MANTA_DUMP_NAME = 'manta.bzip';
var MANTA_DELETE_LOG_DUMP_NAME = 'manta_delete_log.bzip';
var RUNNING_STATE = 'running';

//In Marlin
var MARLIN_PATH_TO_ASSET = MOLA_ASSET_KEY.substring(1);
var MARLIN_ASSET_KEY = MOLA_ASSET_KEY;
var MANTA_GC_ALL_DIR = MANTA_GC_DIR + '/all';
var MANTA_GC_ADO_DIR = MANTA_GC_DIR + '/all/do';
var MANTA_GC_ADN_DIR = MANTA_GC_DIR + '/all/done';
var MANTA_GC_MAKO_DIR = MANTA_GC_DIR + '/mako';
var MANTA_GC_MORAY_DIR = MANTA_GC_DIR + '/moray';



///--- Marlin Commands

/* BEGIN JSSTYLED */
//TODO: Delete me
var WHILE_1 = 'env >/tmp/env.txt && \
while [[ true ]]; do echo Hello; sleep 2; done';
var ECHO_HELLO = 'echo "Hello World!"';

var ENV_COMMON = 'export PATH=/usr/node/bin:$PATH && \
export MANTA_USER=' + MANTA_USER + ' && \
export MANTA_GC=' + GC_JOB_NAME + ' && \
export MARLIN_JOB=$(echo $MANTA_OUTPUT_BASE | cut -d "/" -f 4) && \
export NOW=$(date "+%Y-%m-%d-%H-%M-%S") && \
cd /assets/ && tar -xzf ' + MARLIN_PATH_TO_ASSET + ' && cd mola && \
';
/* END JSSTYLED */



///--- Helpers

/* BEGIN JSSTYLED */
function getPgTransformCmd(earliestDumpDate) {
        return (ENV_COMMON + ' \
export MORAY_SHARD=$(echo $mc_input_key | cut -d "/" -f 5) && \
export DUMP_DATE=$(echo $mc_input_key | cut -d "/" -f 6) && \
bzcat | \
  node ./bin/pg_transform.js -d $DUMP_DATE -e ' + earliestDumpDate + ' \
    -m $MORAY_SHARD \
');
}
/* END JSSTYLED */


/* BEGIN JSSTYLED */
function getGcCmd(gracePeriodSeconds) {
        var gracePeriodOption = '';
        if (gracePeriodSeconds) {
                gracePeriodOption = ' -g ' + gracePeriodSeconds;
        }
        return (ENV_COMMON + ' \
export MANTA_OUT=/$MANTA_USER/stor/$MANTA_GC/all/done/$NOW-$MARLIN_JOB && \
export MANTA_LINKS=/$MANTA_USER/stor/$MANTA_GC/all/do/$NOW-$MARLIN_JOB-links && \
export LINKS_FILE=./links.txt && \
sort | node ./bin/gc.js' + gracePeriodOption + ' | \
  /usr/perl5/bin/perl ./bin/gc_links.pl $MANTA_USER $LINKS_FILE $MANTA_OUT | \
  mpipe $MANTA_OUT && \
cat $LINKS_FILE | mpipe $MANTA_LINKS \
');
}
/* END JSSTYLED */


function parseOptions() {
        var option;
        var opts = {};
        var parser = new getopt.BasicParser('g:',
                                            process.argv);
        while ((option = parser.getopt()) !== undefined && !option.error) {
                switch (option.option) {
                case 'g':
                        opts.gracePeriodSeconds = parseInt(option.optarg, 10);
                        break;
                default:
                        usage('Unknown option: ' + option.option);
                        break;
                }
        }
        return (opts);
}


function usage(msg) {
        if (msg) {
                console.error(msg);
        }
        var str  = 'usage: ' + path.basename(process.argv[1]);
        str += ' [-g grace_period_seconds]';
        console.error(str);
        process.exit(1);
}


function ifError(err, msg) {
        if (err) {
                LOG.error(err, msg);
                process.exit(1);
        }
}


function getObjectsInDir(dir, cb) {
        var keys = [];
        MANTA_CLIENT.ls(dir, {}, function (err, res) {
                ifError(err);

                res.on('object', function (obj) {
                        keys.push(dir + '/' + obj.name);
                });

                res.once('error', function (err2) {
                        cb(err2);
                });

                res.once('end', function () {
                        cb(null, keys);
                });
        });
}


function verifyObjectsExist(keys, dirs, cb) {
        vasync.forEachParallel({
                func: getObjectsInDir,
                inputs: dirs
        }, function (err, res) {
                ifError(err);

                var gotkeys = [];
                var i;
                for (i = 0; i < res.successes.length; ++i) {
                        gotkeys.push.apply(gotkeys, res.successes[i]);
                }

                for (i = 0; i < keys.length; ++i) {
                        if (gotkeys.indexOf(keys[i]) === -1) {
                                LOG.error({ keys: keys, gotkeys: gotkeys },
                                          'Couldnt find all keys in manta.');
                                process.exit(1);
                        }
                }

                cb();
        });
}


function findLatestBackup(shardName, cb) {
        var dir = BACKUP_DIR + '/' + shardName;
        MANTA_CLIENT.ls(dir, {}, function (err, res) {
                ifError(err);

                var dates = [];

                res.on('directory', function (d) {
                        dates.push(d.name);
                });

                res.on('error', function (err2) {
                        cb(err2);
                });

                res.on('end', function () {
                        if (dates.length < 1) {
                                LOG.error('No dumps found for shard ' +
                                          shardName);
                                process.exit(1);
                        }
                        dates.sort();
                        cb(null, dates[dates.length - 1]);
                });
        });
}


function updloadBundle(cb) {
        fs.stat(MOLA_CODE_BUNDLE, function (err, stats) {
                ifError(err);

                if (!stats.isFile()) {
                        console.error(MOLA_CODE_BUNDLE + ' is not a file');
                        process.exit(1);
                }

                var opts = {
                        copies: 2,
                        size: stats.size
                };

                var stream = fs.createReadStream(MOLA_CODE_BUNDLE);
                stream.pause();
                stream.on('open', function () {
                        var p = MOLA_ASSET_KEY;
                        MANTA_CLIENT.put(p, stream, opts, function (err2) {
                                ifError(err2);
                                cb();
                        });
                });
        });
}


function createGcMarlinJob(opts) {
        var job = {
                name: GC_JOB_NAME,
                phases: [ {
                        type: 'storage-map',
                        assets: [ MARLIN_ASSET_KEY ],
                        exec: getPgTransformCmd(opts.earliest_dump)
                }, {
                        type: 'reduce',
                        assets: [ MARLIN_ASSET_KEY ],
                        exec: getGcCmd(opts.gracePeriodSeconds)
                } ]
        };

        LOG.info({ job: job }, 'GC Marlin Job Definition');

        MANTA_CLIENT.createJob(job, function (err, jobId) {
                ifError(err);

                LOG.info({ jobId: jobId }, 'Created Job.');
                var aopts = {
                        end: true
                };
                var keys = opts.keys;

                //Add keys to job...
                MANTA_CLIENT.addJobKey(jobId, keys, aopts, function (err2) {
                        ifError(err2);

                        LOG.info({
                                keys: keys,
                                jobId: jobId
                        }, 'Added keys to job');
                        LOG.info('Done for now.');
                });
        });
}


function setupGcMarlinJob(opts) {
        //Make sure the right directories have been created...
        var m = MANTA_CLIENT;
        vasync.pipeline({
                funcs: [
                        function (_, cb) { m.mkdir(MANTA_GC_DIR, cb); },
                        function (_, cb) { m.mkdir(MANTA_ASSET_DIR, cb); },
                        function (_, cb) { m.mkdir(MANTA_GC_ALL_DIR, cb); },
                        function (_, cb) { m.mkdir(MANTA_GC_ADO_DIR, cb); },
                        function (_, cb) { m.mkdir(MANTA_GC_ADN_DIR, cb); },
                        function (_, cb) { m.mkdir(MANTA_GC_MAKO_DIR, cb); },
                        function (_, cb) { m.mkdir(MANTA_GC_MORAY_DIR, cb); }
                ]
        }, function (err) {
                ifError(err);

                //Upload the bundle to manta
                fs.stat(MOLA_CODE_BUNDLE, function (err2, stats) {
                        ifError(err2);

                        if (!stats.isFile()) {
                                console.error(MOLA_CODE_BUNDLE +
                                              ' isnt a file');
                                process.exit(1);
                        }

                        var o = {
                                copies: 2,
                                size: stats.size
                        };

                        var s = fs.createReadStream(MOLA_CODE_BUNDLE);
                        var p = MOLA_ASSET_KEY;
                        s.pause();
                        s.on('open', function () {
                                MANTA_CLIENT.put(p, s, o, function (e) {
                                        ifError(e);
                                        createGcMarlinJob(opts);
                                });
                        });
                });
        });
}


function runGcWithShards(opts) {
        LOG.info({ opts: opts }, 'Running GC with shards.');
        var shards = opts.shards;
        vasync.forEachParallel({
                func: findLatestBackup,
                inputs: shards
        }, function (err, results) {
                ifError(err);
                if (results.successes.length !== shards.length) {
                        LOG.error('Couldnt find latest backup for all shards.');
                        process.exit(1);
                }

                var keys = [];
                var dirs = [];
                var dates = [];

                for (var i = 0; i < shards.length; ++i) {
                        var date = results.successes[i];
                        dates.push(date);
                        var dir = BACKUP_DIR + '/' + shards[i] + '/' + date;
                        dirs.push(dir);
                        keys.push(dir + '/' + MANTA_DUMP_NAME);
                        keys.push(dir + '/' + MANTA_DELETE_LOG_DUMP_NAME);
                }

                dates.sort();
                var earliest_dump = dates[0];

                verifyObjectsExist(keys, dirs, function () {
                        opts.keys = keys;
                        opts.earliest_dump = earliest_dump;
                        setupGcMarlinJob(opts);
                });
        });
}


function findShards(opts) {
        MANTA_CLIENT.ls(BACKUP_DIR, {}, function (err, res) {
                ifError(err);

                var shards = [];

                res.on('directory', function (dir) {
                        shards.push(dir.name);
                });

                res.on('end', function () {
                        if (shards.length < 1) {
                                LOG.error('No dumps available for processing');
                        }
                        //TODO: Verify with ufds that this is the complete
                        // set of shards.
                        opts.shards = shards;
                        LOG.info({ opts: opts }, 'Running with shards.');
                        runGcWithShards(opts);
                });

                res.on('error', function (err2) {
                        if (err2.code === 'ResourceNotFound') {
                                LOG.info(BACKUP_DIR + ' doesnt exist.');
                                process.exit(0);
                        }
                        ifError(err2);
                });
        });
}



///--- Main

var _opts = parseOptions();
//If a job is already running, kick out.
MANTA_CLIENT.listJobs({ state: RUNNING_STATE }, function (err, res) {
        ifError(err);

        var gcRunning = false;
        var gcObject = {};

        res.on('job', function (job) {
                if (job.name.indexOf(GC_JOB_NAME) === 0) {
                        gcRunning = true;
                        gcObject = job;
                }
        });

        res.on('error', function (err3) {
                LOG.error(err3);
                process.exit(1);
        });

        res.on('end', function () {
                if (gcRunning) {
                        LOG.info(gcObject, 'GC Job already running.');
                        process.exit(1);
                }
                findShards(_opts);
        });
});