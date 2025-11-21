/**
 * MAMA Commands Suite - Entry Point
 *
 * Story M3.1: MAMA Commands Suite
 * Thin wrappers around MAMA API for Claude Code slash commands
 *
 * @module commands
 */

const { mamaSaveCommand } = require('./mama-save');
const { mamaRecallCommand } = require('./mama-recall');
const { mamaSuggestCommand } = require('./mama-suggest');
const { mamaListCommand } = require('./mama-list');
const { mamaConfigureCommand } = require('./mama-configure');

/**
 * MAMA Commands Suite
 *
 * Usage:
 *   const { mamaSave, mamaRecall, mamaSuggest, mamaList, mamaConfigure } = require('./commands');
 *
 *   await mamaSave({ topic, decision, reasoning });
 *   await mamaRecall({ topic });
 *   await mamaSuggest({ query });
 *   await mamaList({ limit });
 *   await mamaConfigure({ show });
 */
module.exports = {
  // Command functions
  mamaSave: mamaSaveCommand,
  mamaRecall: mamaRecallCommand,
  mamaSuggest: mamaSuggestCommand,
  mamaList: mamaListCommand,
  mamaConfigure: mamaConfigureCommand,

  // Named exports (alternative)
  mamaSaveCommand,
  mamaRecallCommand,
  mamaSuggestCommand,
  mamaListCommand,
  mamaConfigureCommand,
};
