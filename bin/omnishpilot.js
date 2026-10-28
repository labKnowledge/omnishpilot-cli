#!/usr/bin/env node
'use strict';

require('../lib/bootstrap');
const { main } = require('../lib');

main(process.argv.slice(2)).catch((err) => {
  console.error(err?.stack || err?.message || err);
  process.exit(1);
});
