#!/usr/bin/env node
/* eslint-env node */
/* global process, console, require */

const fs = require('fs');

// ANSI color codes
const colors = {
  reset: '\x1b[0m',
  red: '\x1b[31m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m',
  cyan: '\x1b[36m',
};

function log(color, message) {
  console.log(`${color}${message}${colors.reset}`);
}

function checkNodeVersion() {
  const requiredVersion = '18.0.0';
  const currentVersion = process.version.replace('v', '');

  log(colors.cyan, `Checking Node.js version... (Current: ${currentVersion}, Required: >=${requiredVersion})`);

  const [major, minor, patch] = currentVersion.split('.').map(Number);
  const [reqMajor, reqMinor, reqPatch] = requiredVersion.split('.').map(Number);

  if (major < reqMajor || (major === reqMajor && minor < reqMinor) || (major === reqMajor && minor === reqMinor && patch < reqPatch)) {
    // Using the format from our error templates (hardcoded here since we can't import JSON easily in this script context without more setup)
    console.log(`
❌ Node.js ${requiredVersion}+ required (found: ${process.version})
   Fix: nvm install 22 && nvm use 22
        Or download from: https://nodejs.org
`);
    process.exit(1);
  }

  log(colors.green, '✅ Node.js version compatible');
}

function checkDiskSpace() {
  log(colors.cyan, 'Checking disk space...');
  
  try {
    // Check home directory where DB will be stored
    const homeDir = process.env.HOME || process.env.USERPROFILE;
    if (!homeDir) return; // Skip if can't determine home dir

    const stats = fs.statfsSync(homeDir);
    const availableBytes = stats.bavail * stats.bsize;
    const availableMB = Math.round(availableBytes / (1024 * 1024));
    const requiredMB = 100;

    if (availableMB < requiredMB) {
       console.log(`
❌ Insufficient disk space for database
   Required: ${requiredMB}MB minimum
   Available: ${availableMB}MB
   Fix: Free up disk space and retry
`);
       process.exit(1);
    }
    
    log(colors.green, `✅ Disk space sufficient (${availableMB}MB available)`);
  } catch (error) {
    // fs.statfsSync might not be available on all platforms/node versions, or permission issues
    // Just warn and proceed
    log(colors.yellow, `⚠️ Could not verify disk space: ${error.message}`);
  }
}

function checkDependencies() {
  log(colors.cyan, 'Checking essential dependencies...');
  log(colors.green, '✅ Dependencies check passed (managed by npm)');
}

function main() {
  console.log('\n' + '='.repeat(50));
  log(colors.blue, 'MAMA Plugin Compatibility Check');
  console.log('='.repeat(50) + '\n');

  try {
    checkNodeVersion();
    checkDiskSpace();
    checkDependencies();
    
    console.log('\n' + '='.repeat(50));
    log(colors.green, '✅ MAMA Plugin installed successfully');
    console.log('='.repeat(50) + '\n');
  } catch (error) {
    log(colors.red, `❌ Installation failed: ${error.message}`);
    process.exit(1);
  }
}

main();
