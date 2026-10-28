#!/usr/bin/env node
'use strict';

process.exitCode = require('../lib/agent-run').main(process.argv.slice(2));
