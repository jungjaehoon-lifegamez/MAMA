const mama = require('@jungjaehoon/mama-core/mama-api');

async function mamaProfileCommand(args = {}) {
  try {
    const scopes = Array.isArray(args.scopes) ? args.scopes : [];
    const profile = await mama.buildProfile(scopes);

    return {
      success: true,
      profile,
      message: formatProfileMessage(profile),
    };
  } catch (err) {
    return {
      success: false,
      error: err.message,
      message: `## ❌ Error Loading Profile\n\n${err.message}`,
    };
  }
}

function formatProfileMessage(profile) {
  const staticItems = profile.static || [];
  const dynamicItems = profile.dynamic || [];
  const evidenceItems = profile.evidence || [];

  const lines = ['## 👤 MAMA Profile', '', '### Static Profile'];
  if (staticItems.length === 0) {
    lines.push('- None');
  } else {
    for (const item of staticItems) {
      lines.push(`- ${item.summary || item.decision || item.topic}`);
    }
  }

  lines.push('', '### Dynamic Profile');
  if (dynamicItems.length === 0) {
    lines.push('- None');
  } else {
    for (const item of dynamicItems) {
      lines.push(`- ${item.summary || item.decision || item.topic}`);
    }
  }

  lines.push('', '### Evidence');
  if (evidenceItems.length === 0) {
    lines.push('- None');
  } else {
    for (const item of evidenceItems) {
      lines.push(`- ${item.topic}: ${item.why_included}`);
    }
  }

  return lines.join('\n');
}

module.exports = { mamaProfileCommand };
