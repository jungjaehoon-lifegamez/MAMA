#!/usr/bin/env node
'use strict';

const ALL_FEATURES = ['memory', 'keywords', 'rules', 'agents', 'contracts'];

function getEnabledFeatures() {
  const isDaemon = process.env.MAMA_DAEMON === '1';
  const disableAll = process.env.MAMA_DISABLE_HOOKS === 'true';
  const featuresEnv = process.env.MAMA_HOOK_FEATURES;
  if (disableAll) {
    return new Set();
  }
  if (!isDaemon) {
    return new Set(ALL_FEATURES);
  }
  if (!featuresEnv) {
    return new Set();
  }
  return new Set(featuresEnv.split(',').map((f) => f.trim().toLowerCase()));
}

module.exports = { getEnabledFeatures, ALL_FEATURES };
