// =============================================================================
// CYBERDECK IDEAS — Content Moderation Filter
// =============================================================================
// Basic profanity and slur filter. Catches common offensive terms and some
// evasion techniques. Not exhaustive — admin moderation is the final layer.
// =============================================================================

const ProfanityFilter = (() => {
  // Offensive terms (hashed patterns to keep source cleaner)
  // Covers: racial slurs, homophobic slurs, sexist slurs, hate speech
  const BLOCKED = [
    'n[i1!|][gq6][gq6][e3a@][r7]',
    'n[i1!|][gq6]{2,}',
    'f[a@4][gq6]{1,2}[o0][t7]',
    'f[a@4][gq6]{1,2}[s5]?',
    'r[e3]t[a@4]rd',
    'tr[a@4]nn[yi1]',
    'k[i1][k]+[e3]',
    'sp[i1][ckx]',
    'ch[i1]n[k]+',
    'g[o0]{2,}k',
    'w[e3]tb[a@4]ck',
    'b[e3][a@4]n[e3]r',
    'c[o0]{2,}n',
    'r[a@4]g?h[e3][a@4]d',
    'j[i1][gq6][a@4]b[o0]{2,}',
    'd[yi1]k[e3]',
    'c[u]+nt',
    'tw[a@4]t',
    'wh[o0]r[e3]',
    'sl[u]+t',
  ];

  const BLOCKED_EXACT = [
    'kys', 'stfu', 'gtfo',
  ];

  // Build regex patterns
  const patterns = BLOCKED.map(p => new RegExp(`\\b${p}\\b`, 'i'));
  const exactPatterns = BLOCKED_EXACT.map(p => new RegExp(`\\b${p}\\b`, 'i'));

  // Normalize text: strip common evasion characters
  function normalize(text) {
    return text
      .replace(/[\s_\-.*]+/g, '')   // Remove spacers
      .replace(/0/g, 'o')
      .replace(/1/g, 'i')
      .replace(/3/g, 'e')
      .replace(/4/g, 'a')
      .replace(/5/g, 's')
      .replace(/7/g, 't')
      .replace(/@/g, 'a')
      .replace(/\$/g, 's')
      .replace(/!/g, 'i')
      .replace(/\|/g, 'l');
  }

  function check(text) {
    if (!text) return { clean: true };

    const raw = text.toLowerCase();
    const normalized = normalize(raw);

    // Check raw text
    for (const pattern of patterns) {
      if (pattern.test(raw)) {
        return { clean: false, reason: 'Content contains offensive language.' };
      }
    }

    // Check normalized text against simpler versions
    const simplePatterns = BLOCKED.map(p => {
      const simple = p
        .replace(/\[.*?\]/g, m => m[1])
        .replace(/\{.*?\}/g, '+')
        .replace(/\?/g, '');
      return new RegExp(simple, 'i');
    });

    for (const pattern of simplePatterns) {
      if (pattern.test(normalized)) {
        return { clean: false, reason: 'Content contains offensive language.' };
      }
    }

    // Check exact matches
    for (const pattern of exactPatterns) {
      if (pattern.test(raw)) {
        return { clean: false, reason: 'Content contains inappropriate language.' };
      }
    }

    return { clean: true };
  }

  function checkAll(title, description) {
    const titleCheck = check(title);
    if (!titleCheck.clean) return titleCheck;
    const descCheck = check(description);
    if (!descCheck.clean) return descCheck;
    return { clean: true };
  }

  return { check, checkAll };
})();
