const fs = require('fs');
const os = require('os');
const path = require('path');

const DATA_DIR = process.env.VAYU_DATA_DIR || path.join(os.homedir(), 'Library', 'Application Support', 'Vayu');
const TRANSCRIPTS_DIR = path.join(DATA_DIR, 'transcripts');

// Ensure transcripts directory exists
if (!fs.existsSync(TRANSCRIPTS_DIR)) {
  fs.mkdirSync(TRANSCRIPTS_DIR, { recursive: true });
}

/**
 * Serializes a JS object to a simple YAML string
 */
function serializeYAML(obj) {
  let yaml = '';
  for (const [key, val] of Object.entries(obj)) {
    if (Array.isArray(val)) {
      yaml += `${key}:\n`;
      val.forEach(item => {
        yaml += `  - "${String(item).replace(/"/g, '\\"')}"\n`;
      });
    } else {
      yaml += `${key}: "${String(val).replace(/"/g, '\\"')}"\n`;
    }
  }
  return yaml;
}

/**
 * Parses a simple YAML string into a JS object
 */
function parseYAML(yamlStr) {
  const lines = yamlStr.split('\n');
  const obj = {};
  let currentKey = null;
  
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    
    if (line.startsWith('  - ')) {
      if (currentKey && Array.isArray(obj[currentKey])) {
        // Strip leading dash, spaces and quotes
        const val = trimmed.substring(2).replace(/^["']|["']$/g, '').trim();
        obj[currentKey].push(val);
      }
    } else if (line.includes(':')) {
      const idx = line.indexOf(':');
      const key = line.substring(0, idx).trim();
      const val = line.substring(idx + 1).trim();
      if (val === '') {
        obj[key] = [];
        currentKey = key;
      } else {
        obj[key] = val.replace(/^["']|["']$/g, '').trim();
        currentKey = null;
      }
    }
  }
  return obj;
}

/**
 * Saves a transcript entry as a YAML file
 */
function saveTranscript(text, tags) {
  const now = new Date();
  const timestamp = now.toISOString();
  
  // Format filename: YYYYMMDD_HHMMSS.yaml
  const pad = (n) => String(n).padStart(2, '0');
  const yyyymmdd = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}`;
  const hhmmss = `${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
  const filename = `${yyyymmdd}_${hhmmss}.yaml`;
  const filePath = path.join(TRANSCRIPTS_DIR, filename);
  
  const obj = {
    timestamp,
    text,
    tags
  };
  
  const yamlContent = serializeYAML(obj);
  fs.writeFileSync(filePath, yamlContent, 'utf-8');
  console.log(`Saved transcript to ${filePath}`);
  return obj;
}

/**
 * Loads all transcripts from the transcripts folder sorted chronologically (newest first)
 */
function getAllTranscripts() {
  if (!fs.existsSync(TRANSCRIPTS_DIR)) return [];
  
  const files = fs.readdirSync(TRANSCRIPTS_DIR);
  const transcripts = [];
  
  for (const file of files) {
    if (!file.endsWith('.yaml')) continue;
    try {
      const filePath = path.join(TRANSCRIPTS_DIR, file);
      const content = fs.readFileSync(filePath, 'utf-8');
      const obj = parseYAML(content);
      obj._file = file; // Store filename reference
      transcripts.push(obj);
    } catch (err) {
      console.error(`Error reading ${file}:`, err);
    }
  }
  
  // Sort newest first
  transcripts.sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));
  return transcripts;
}

module.exports = {
  serializeYAML,
  parseYAML,
  saveTranscript,
  getAllTranscripts
};
