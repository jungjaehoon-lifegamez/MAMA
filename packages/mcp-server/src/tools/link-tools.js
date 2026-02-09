/**
 * MCP Tools: Link Collaboration & Governance (Epic 3)
 *
 * Tools for proposing, approving, and managing decision links.
 *
 * @module link-tools
 */

const mama = require('@jungjaehoon/mama-core/mama-api');

/**
 * Propose Link Tool (Story 3.1)
 */
const proposeLinkTool = {
  name: 'propose_link',
  description: `Propose a new relationship link between two decisions for user approval.

  LLM can suggest links when it identifies relationships, but links require user approval before becoming active.

  Use this when you notice:
  - One decision refines/extends another decision
  - Two decisions contradict each other

  IMPORTANT: Links are NOT automatically created. They require user approval.`,
  inputSchema: {
    type: 'object',
    properties: {
      from_id: {
        type: 'string',
        description: 'Source decision ID (the decision that refines/contradicts)',
      },
      to_id: {
        type: 'string',
        description: 'Target decision ID (the decision being refined/contradicted)',
      },
      relationship: {
        type: 'string',
        enum: ['refines', 'contradicts'],
        description: '"refines" if from_id extends/improves to_id, "contradicts" if they conflict',
      },
      reason: {
        type: 'string',
        description:
          'Clear explanation of why this link should exist (e.g., "Decision A adds authentication details missing in Decision B")',
      },
      decision_id: {
        type: 'string',
        description: 'Optional: The decision context where this link was identified',
      },
      evidence: {
        type: 'string',
        description: 'Optional: Supporting evidence (file paths, logs, metrics)',
      },
    },
    required: ['from_id', 'to_id', 'relationship', 'reason'],
  },
  handler: async (args) => {
    try {
      await mama.proposeLink(args);
      return {
        content: [
          {
            type: 'text',
            text: `✅ Link Proposed\n\nFrom: ${args.from_id}\nTo: ${args.to_id}\nRelationship: ${args.relationship}\nReason: ${args.reason}\n\n⚠️ This link is pending user approval. Use /mama-links to review pending links.`,
          },
        ],
      };
    } catch (error) {
      return {
        content: [
          {
            type: 'text',
            text: `❌ Failed to propose link: ${error.message}`,
          },
        ],
      };
    }
  },
};

/**
 * Approve Link Tool (Story 3.1)
 */
const approveLinkTool = {
  name: 'approve_link',
  description: 'Approve a pending link, making it active in the decision graph.',
  inputSchema: {
    type: 'object',
    properties: {
      from_id: {
        type: 'string',
        description: 'Source decision ID',
      },
      to_id: {
        type: 'string',
        description: 'Target decision ID',
      },
      relationship: {
        type: 'string',
        enum: ['refines', 'contradicts'],
        description: 'Link relationship type',
      },
    },
    required: ['from_id', 'to_id', 'relationship'],
  },
  handler: async (args) => {
    try {
      await mama.approveLink(args.from_id, args.to_id, args.relationship);
      return {
        content: [
          {
            type: 'text',
            text: `✅ Link Approved\n\nThe link is now active in the decision graph.`,
          },
        ],
      };
    } catch (error) {
      return {
        content: [
          {
            type: 'text',
            text: `❌ Failed to approve link: ${error.message}`,
          },
        ],
      };
    }
  },
};

/**
 * Reject Link Tool (Story 3.1)
 */
const rejectLinkTool = {
  name: 'reject_link',
  description: 'Reject a pending link, removing it from the database.',
  inputSchema: {
    type: 'object',
    properties: {
      from_id: {
        type: 'string',
        description: 'Source decision ID',
      },
      to_id: {
        type: 'string',
        description: 'Target decision ID',
      },
      relationship: {
        type: 'string',
        enum: ['refines', 'contradicts'],
        description: 'Link relationship type',
      },
      reason: {
        type: 'string',
        description: 'Optional reason for rejection',
      },
    },
    required: ['from_id', 'to_id', 'relationship'],
  },
  handler: async (args) => {
    try {
      await mama.rejectLink(args.from_id, args.to_id, args.relationship, args.reason);
      return {
        content: [
          {
            type: 'text',
            text: `✅ Link Rejected\n\nThe proposed link has been removed.`,
          },
        ],
      };
    } catch (error) {
      return {
        content: [
          {
            type: 'text',
            text: `❌ Failed to reject link: ${error.message}`,
          },
        ],
      };
    }
  },
};

/**
 * Get Pending Links Tool (Story 3.1)
 */
const getPendingLinksTool = {
  name: 'get_pending_links',
  description: 'List all pending links awaiting user approval.',
  inputSchema: {
    type: 'object',
    properties: {
      from_id: {
        type: 'string',
        description: 'Optional: Filter by source decision ID',
      },
      to_id: {
        type: 'string',
        description: 'Optional: Filter by target decision ID',
      },
    },
  },
  handler: async (args) => {
    try {
      const links = await mama.getPendingLinks(args || {});

      if (links.length === 0) {
        return {
          content: [
            {
              type: 'text',
              text: `✅ No Pending Links\n\nAll proposed links have been reviewed.`,
            },
          ],
        };
      }

      let output = `📋 Pending Links (${links.length})\n\n`;

      links.forEach((link, idx) => {
        output += `${idx + 1}. ${link.relationship.toUpperCase()}\n`;
        output += `   From: ${link.from_topic} (${link.from_id})\n`;
        output += `   To: ${link.to_topic} (${link.to_id})\n`;
        output += `   Reason: ${link.reason}\n`;
        if (link.evidence) {
          output += `   Evidence: ${link.evidence}\n`;
        }
        output += `   Proposed: ${new Date(link.created_at).toLocaleString()}\n\n`;
      });

      output += `\nTo approve/reject, use:\n`;
      output += `- mama.approveLink(from_id, to_id, relationship)\n`;
      output += `- mama.rejectLink(from_id, to_id, relationship, reason)\n`;

      return {
        content: [
          {
            type: 'text',
            text: output,
          },
        ],
      };
    } catch (error) {
      return {
        content: [
          {
            type: 'text',
            text: `❌ Failed to get pending links: ${error.message}`,
          },
        ],
      };
    }
  },
};

/**
 * Deprecate Auto Links Tool (Story 3.3)
 */
const deprecateAutoLinksTool = {
  name: 'deprecate_auto_links',
  description: `Identify and optionally remove v0 auto-generated links that lack explicit approval context.

  IMPORTANT: This is a maintenance operation for migrating from v0 to v1.1.
  - Protected links (with decision_id or created_by='llm') are preserved
  - Use dryRun=true first to preview changes
  - Creates audit trail for all deprecations`,
  inputSchema: {
    type: 'object',
    properties: {
      dryRun: {
        type: 'boolean',
        description:
          'If true, only report without deleting (default: true). Set to false to execute deletion.',
      },
    },
  },
  handler: async (args) => {
    try {
      const { dryRun = true } = args || {};
      const report = await mama.deprecateAutoLinks({ dryRun });

      let output = `📊 Auto-Link Deprecation Report\n\n`;
      output += `Mode: ${report.dryRun ? '🔍 DRY RUN (Preview Only)' : '🗑️  EXECUTION'}\n\n`;
      output += `📈 Statistics:\n`;
      output += `- Auto-generated links: ${report.deprecated}\n`;
      output += `- Protected links: ${report.protected}\n`;
      output += `- Total links: ${report.total}\n`;
      output += `- Auto-link ratio: ${report.autoLinkRatio}\n\n`;

      if (report.links.length > 0) {
        output += `📋 Auto-Generated Links (${report.links.length}):\n\n`;
        report.links.slice(0, 10).forEach((link, idx) => {
          output += `${idx + 1}. ${link.relationship}: ${link.from_id} → ${link.to_id}\n`;
          if (link.reason) {
            output += `   Reason: ${link.reason}\n`;
          }
        });

        if (report.links.length > 10) {
          output += `\n... and ${report.links.length - 10} more\n`;
        }

        if (report.dryRun) {
          output += `\n⚠️  To execute deprecation, call with dryRun=false\n`;
        } else {
          output += `\n✅ Auto-generated links have been deprecated and removed.\n`;
          output += `📝 Audit trail recorded in link_audit_log table.\n`;
        }
      } else {
        output += `✅ No auto-generated links found.\n`;
        output += `All links have explicit approval context.\n`;
      }

      return {
        content: [
          {
            type: 'text',
            text: output,
          },
        ],
      };
    } catch (error) {
      return {
        content: [
          {
            type: 'text',
            text: `❌ Failed to deprecate auto-links: ${error.message}`,
          },
        ],
      };
    }
  },
};

/**
 * Scan Auto Links Tool (Story 5.1)
 */
const scanAutoLinksTool = {
  name: 'scan_auto_links',
  description: 'Scan and identify auto-generated links for cleanup',
  inputSchema: {
    type: 'object',
    properties: {
      include_samples: {
        type: 'boolean',
        description: 'Include sample links in output (default: true)',
      },
    },
  },
  handler: async (args) => {
    try {
      const { include_samples = true } = args;
      const scanResult = mama.scanAutoLinks();

      let output = `# Auto-Link Scan Results\n\n`;
      output += `**Statistics:**\n`;
      output += `- Total Links: ${scanResult.total_links}\n`;
      output += `- Auto Links: ${scanResult.auto_links}\n`;
      output += `- Protected Links: ${scanResult.protected_links}\n`;
      output += `- Deletion Targets: ${scanResult.deletion_targets}\n\n`;

      if (include_samples && scanResult.deletion_target_list.length > 0) {
        output += `**Sample Deletion Targets (first 5):**\n\n`;
        scanResult.deletion_target_list.slice(0, 5).forEach((link, idx) => {
          output += `${idx + 1}. ${link.from_id} → ${link.to_id} (${link.relationship})\n`;
          output += `   - Reason: ${link.reason || 'N/A'}\n`;
          output += `   - Created By: ${link.created_by || 'N/A'}\n`;
          output += `   - Approved: ${link.approved_by_user ? 'Yes' : 'No'}\n\n`;
        });
      }

      output += `\n**Next Steps:**\n`;
      output += `1. Review deletion targets above\n`;
      output += `2. Run \`create_link_backup\` to create backup\n`;
      output += `3. Run \`generate_cleanup_report\` for detailed report\n`;

      return {
        content: [
          {
            type: 'text',
            text: output,
          },
        ],
      };
    } catch (error) {
      return {
        content: [
          {
            type: 'text',
            text: `❌ Failed to scan auto-links: ${error.message}`,
          },
        ],
      };
    }
  },
};

/**
 * Create Link Backup Tool (Story 5.1)
 */
const createLinkBackupTool = {
  name: 'create_link_backup',
  description: 'Create backup of auto-generated links before cleanup',
  inputSchema: {
    type: 'object',
    properties: {
      include_protected: {
        type: 'boolean',
        description: 'Include protected links in backup (default: false)',
      },
    },
  },
  handler: async (args) => {
    try {
      const { include_protected = false } = args;
      const scanResult = mama.scanAutoLinks();

      const linksToBackup = include_protected
        ? scanResult.deletion_target_list.concat(
            // Would need to query protected links separately
            []
          )
        : scanResult.deletion_target_list;

      const backupResult = mama.createLinkBackup(linksToBackup);

      let output = `# Backup Created Successfully\n\n`;
      output += `**Backup File:** ${backupResult.backup_file}\n`;
      output += `**Manifest File:** ${backupResult.manifest_file}\n`;
      output += `**Checksum:** ${backupResult.checksum}\n`;
      output += `**Links Backed Up:** ${backupResult.link_count}\n\n`;
      output += `✅ Backup complete. You can now proceed with cleanup.\n`;

      return {
        content: [
          {
            type: 'text',
            text: output,
          },
        ],
      };
    } catch (error) {
      return {
        content: [
          {
            type: 'text',
            text: `❌ Failed to create backup: ${error.message}`,
          },
        ],
      };
    }
  },
};

/**
 * Generate Cleanup Report Tool (Story 5.1)
 */
const generateCleanupReportTool = {
  name: 'generate_cleanup_report',
  description: 'Generate pre-cleanup report with risk assessment',
  inputSchema: {
    type: 'object',
    properties: {
      format: {
        type: 'string',
        enum: ['json', 'markdown'],
        description: 'Output format (default: markdown)',
      },
    },
  },
  handler: async (args) => {
    try {
      const { format = 'markdown' } = args;
      const reportResult = mama.generatePreCleanupReport();

      if (format === 'json') {
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(reportResult.report, null, 2),
            },
          ],
        };
      }

      let output = `# Pre-Cleanup Report Generated\n\n`;
      output += `**Report File:** ${reportResult.report_file}\n\n`;
      output += `---\n\n`;
      output += reportResult.markdown;

      return {
        content: [
          {
            type: 'text',
            text: output,
          },
        ],
      };
    } catch (error) {
      return {
        content: [
          {
            type: 'text',
            text: `❌ Failed to generate cleanup report: ${error.message}`,
          },
        ],
      };
    }
  },
};

/**
 * Restore Link Backup Tool (Story 5.1)
 */
const restoreLinkBackupTool = {
  name: 'restore_link_backup',
  description: 'Restore links from backup file (rollback)',
  inputSchema: {
    type: 'object',
    properties: {
      backup_file: {
        type: 'string',
        description: 'Path to backup file',
      },
    },
    required: ['backup_file'],
  },
  handler: async (args) => {
    try {
      const { backup_file } = args;
      const restoreResult = mama.restoreLinkBackup(backup_file);

      let output = `# Backup Restored\n\n`;
      output += `**Backup File:** ${restoreResult.backup_file}\n`;
      output += `**Total Links:** ${restoreResult.total_links}\n`;
      output += `**Restored:** ${restoreResult.restored}\n`;
      output += `**Failed:** ${restoreResult.failed}\n\n`;

      if (restoreResult.failed > 0) {
        output += `⚠️ Some links failed to restore. Check logs for details.\n`;
      } else {
        output += `✅ All links restored successfully.\n`;
      }

      return {
        content: [
          {
            type: 'text',
            text: output,
          },
        ],
      };
    } catch (error) {
      return {
        content: [
          {
            type: 'text',
            text: `❌ Failed to restore backup: ${error.message}`,
          },
        ],
      };
    }
  },
};

/**
 * Execute Link Cleanup Tool (Story 5.2)
 */
const executeLinkCleanupTool = {
  name: 'execute_link_cleanup',
  description: 'Execute auto-generated link cleanup with batch deletion and transaction support',
  inputSchema: {
    type: 'object',
    properties: {
      batch_size: {
        type: 'number',
        description: 'Number of links to delete per batch (default: 100)',
      },
      dry_run: {
        type: 'boolean',
        description: 'Simulate deletion without actual DB changes (default: true for safety)',
      },
    },
  },
  handler: async (args) => {
    try {
      const { batch_size = 100, dry_run = true } = args;
      const result = mama.deleteAutoLinks(batch_size, dry_run);

      let output = `# Link Cleanup Execution\n\n`;

      if (result.dry_run) {
        output += `**Mode:** DRY RUN MODE (simulation)\n\n`;
        output += `**Would Delete:** ${result.would_delete}\n`;
        output += `**Backup File:** ${result.backup_file}\n\n`;
        output += `**Sample Links (first 5):**\n\n`;
        result.sample_links?.forEach((link, idx) => {
          output += `${idx + 1}. ${link.from_id} → ${link.to_id} (${link.relationship})\n`;
        });
        output += `\n${result.message}\n`;
        output += `\n⚠️ To execute actual deletion, run with \`dry_run: false\`\n`;
      } else {
        output += `**Mode:** Cleanup Execution Complete\n\n`;
        output += `**Results:**\n`;
        output += `- Deleted: ${result.deleted}\n`;
        output += `- Failed: ${result.failed}\n`;
        output += `- Total Targets: ${result.total_targets}\n`;
        output += `- Success Rate: ${result.success_rate}%\n`;
        output += `- Backup File: ${result.backup_file}\n\n`;

        if (result.errors && result.errors.length > 0) {
          output += `**Errors (first ${result.errors.length}):**\n\n`;
          result.errors.forEach((err, idx) => {
            output += `${idx + 1}. ${err.link || `Batch ${err.batch_index}`}: ${err.error}\n`;
          });
          output += `\n`;
        }

        if (result.deleted > 0) {
          output += `✅ Cleanup completed. Run \`validate_cleanup_result\` to verify.\n`;
        } else {
          output += `⚠️ No links were deleted. ${result.message}\n`;
        }
      }

      return {
        content: [
          {
            type: 'text',
            text: output,
          },
        ],
      };
    } catch (error) {
      return {
        content: [
          {
            type: 'text',
            text: `❌ Failed to execute link cleanup: ${error.message}`,
          },
        ],
      };
    }
  },
};

/**
 * Validate Cleanup Result Tool (Story 5.2)
 */
const validateCleanupResultTool = {
  name: 'validate_cleanup_result',
  description: 'Validate cleanup result and generate post-cleanup report with success criteria',
  inputSchema: {
    type: 'object',
    properties: {
      format: {
        type: 'string',
        enum: ['json', 'markdown'],
        description: 'Output format (default: markdown)',
      },
    },
  },
  handler: async (args) => {
    try {
      const { format = 'markdown' } = args;
      const result = mama.validateCleanupResult();

      if (format === 'json') {
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(
                {
                  status: result.status,
                  auto_links_remaining: result.auto_links_remaining,
                  remaining_ratio: result.remaining_ratio,
                  total_links_before: result.total_links_before,
                  protected_links: result.protected_links,
                  report: result.report,
                  report_file: result.report_file,
                },
                null,
                2
              ),
            },
          ],
        };
      }

      let output = `# Post-Cleanup Validation\n\n`;
      output += `**Report File:** ${result.report_file}\n\n`;
      output += `---\n\n`;
      output += result.markdown;

      return {
        content: [
          {
            type: 'text',
            text: output,
          },
        ],
      };
    } catch (error) {
      return {
        content: [
          {
            type: 'text',
            text: `❌ Failed to validate cleanup result: ${error.message}`,
          },
        ],
      };
    }
  },
};

module.exports = {
  proposeLinkTool,
  approveLinkTool,
  rejectLinkTool,
  getPendingLinksTool,
  deprecateAutoLinksTool,
  // Epic 5: Migration & Cleanup (Story 5.1)
  scanAutoLinksTool,
  createLinkBackupTool,
  generateCleanupReportTool,
  restoreLinkBackupTool,
  // Epic 5: Migration & Cleanup (Story 5.2)
  executeLinkCleanupTool,
  validateCleanupResultTool,
};
