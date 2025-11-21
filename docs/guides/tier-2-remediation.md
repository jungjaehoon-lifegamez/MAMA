# Tier 2 Remediation Guide

**Goal:** Upgrade from Tier 2 (Fallback Mode) to Tier 1 (Full Features)

**Status Check:**
```
/mama-list

🔍 System Status: 🟡 Tier 2 | Embeddings unavailable
```

If you see this, follow these steps.

---

## Why Am I in Tier 2?

**Common causes:**
1. **First install** - Transformers.js model not downloaded yet
2. **Network issue** - Model download failed during first use
3. **Disk space** - Insufficient space for model cache (~120MB)
4. **Platform incompatibility** - Some edge cases on ARM64/Windows

---

## Step 1: Check Model Download

```bash
# Check if model cache exists
ls -la ~/.cache/huggingface/

# Expected: transformers/ directory with ~120MB
```

**If missing:** Model download failed during first use.

---

## Step 2: Manual Model Download

```bash
# Force model download (takes ~987ms on first run)
node -e "
const { pipeline } = require('@huggingface/transformers');
(async () => {
  const extractor = await pipeline('feature-extraction', 'Xenova/multilingual-e5-small');
  console.log('✅ Model downloaded successfully');
})();
"
```

**Expected output:**
```
dtype not specified for "model". Using the default dtype (fp32) for this device (cpu).
✅ Model downloaded successfully
```

---

## Step 3: Verify Disk Space

```bash
# Check available space
df -h ~

# Required: At least 500MB free for model cache + database
```

**If insufficient space:**
```bash
# Clear old model caches
rm -rf ~/.cache/huggingface/transformers/.cache

# Clear npm cache
npm cache clean --force
```

---

## Step 4: Verify Tier Upgrade

```bash
# Restart Claude Code, then check tier
/mama-list

# Expected:
🔍 System Status: 🟢 Tier 1 | Full Features Active
```

---

## Still Tier 2?

**Platform-specific issues:**

### ARM64 (Apple Silicon M1/M2)
- Some ONNX runtime issues on ARM64
- Try: `arch -x86_64 npm install` (use Rosetta)

### Windows
- May need Visual Studio Build Tools
- See [Troubleshooting - SQLite Build Failures](troubleshooting.md#2-sqlite-build-failures)

### Corporate Networks
- Firewall may block Hugging Face CDN
- See [Troubleshooting - Firewall/Proxy Issues](troubleshooting.md#check-4-firewallproxy-issues)

---

**Related:**
- [Understanding Tiers Tutorial](../tutorials/understanding-tiers.md)
- [Troubleshooting Guide](troubleshooting.md)
- [Tier System Explanation](../explanation/tier-system.md)
