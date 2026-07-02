/**
 * Tagger.js — Heuristic tag extractor for Vayu transcriptions
 */

const KEYWORD_TAG_MAP = {
  // AI topics
  'ai': 'AI', 'llm': 'AI', 'claude': 'AI', 'gpt': 'AI', 'whisper': 'AI', 'prompt': 'AI', 'agent': 'AI',
  // Graphics topics
  'shader': 'Graphics', 'glsl': 'Graphics', 'webgpu': 'Graphics', 'opengl': 'Graphics', 'three': 'Graphics', 
  'canvas': 'Graphics', 'rendering': 'Graphics', 'render': 'Graphics', 'graphics': 'Graphics',
  // Games & Audio
  'game': 'Games', 'audio': 'Games', 'sound': 'Games', 'synth': 'Games', 'music': 'Games',
  // Low-level & math
  'kernel': 'Systems', 'os': 'Systems', 'blowfish': 'Systems', 'crypto': 'Systems', 'math': 'Systems', 
  'systems': 'Systems', 'rust': 'Systems', 'c++': 'Systems',
  // DevOps & Tooling
  'docker': 'DevOps', 'cli': 'DevOps', 'git': 'DevOps', 'devops': 'DevOps', 'workflow': 'DevOps',
  // Frontend
  'react': 'Frontend', 'vue': 'Frontend', 'tailwind': 'Frontend', 'html': 'Frontend', 'css': 'Frontend', 
  'web': 'Frontend', 'dashboard': 'Frontend', 'frontend': 'Frontend',
  // Desktop
  'electron': 'Desktop App', 'vayu': 'Desktop App', 'desktop': 'Desktop App', 'overlay': 'Desktop App'
};

/**
 * Parses a transcription string and extracts a list of relevant tags
 */
function extractTags(text) {
  if (!text) return [];
  
  const tags = new Set();
  const lowerText = text.toLowerCase();
  
  // 1. Extract hashtags (e.g. #WebGL, #AI, #Vayu)
  const hashtagRegex = /#([a-zA-Z0-9_-]+)/g;
  let match;
  while ((match = hashtagRegex.exec(text)) !== null) {
    const rawTag = match[1].trim();
    if (rawTag.length > 0) {
      // Title-case single letters, preserve others
      const formatted = rawTag.length === 1 ? rawTag.toUpperCase() : rawTag;
      tags.add(formatted);
    }
  }
  
  // 2. Extract verbal "tags:" pattern (e.g. "tags: swift, backend")
  const verbalRegex = /tags?:\s*([a-zA-Z0-9_,\s-]+)/i;
  const verbalMatch = verbalRegex.exec(text);
  if (verbalMatch) {
    const list = verbalMatch[1].split(',');
    list.forEach(item => {
      const trimmed = item.trim();
      if (trimmed.length > 0) {
        tags.add(trimmed.charAt(0).toUpperCase() + trimmed.slice(1));
      }
    });
  }
  
  // 3. Keyword dictionary auto-tagging
  const words = lowerText.split(/[^a-zA-Z0-9+#]/);
  words.forEach(word => {
    if (KEYWORD_TAG_MAP[word]) {
      tags.add(KEYWORD_TAG_MAP[word]);
    }
  });
  
  // Convert Set to array, filter out hashtags that are just numbers/invalid, and sort
  return Array.from(tags)
    .filter(t => t && t.length > 0)
    .sort((a, b) => a.localeCompare(b));
}

module.exports = {
  extractTags
};
