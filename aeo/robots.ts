export interface RobotsGroup {
  agents: string[];
  rules: { allow: boolean; path: string }[];
}

export interface Robots {
  groups: RobotsGroup[];
  sitemaps: string[];
  contentSignals: string[];
}

export function parseRobots(text: string): Robots {
  const robots: Robots = { groups: [], sitemaps: [], contentSignals: [] };
  let group: RobotsGroup | null = null;
  let inAgents = false;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.replace(/#.*/, '').trim();
    const i = line.indexOf(':');
    if (i < 1) continue;
    const key = line.slice(0, i).trim().toLowerCase();
    const value = line.slice(i + 1).trim();
    if (key === 'user-agent') {
      if (!group || !inAgents) {
        group = { agents: [], rules: [] };
        robots.groups.push(group);
      }
      group.agents.push(value.toLowerCase());
      inAgents = true;
      continue;
    }
    inAgents = false;
    if (key === 'sitemap') robots.sitemaps.push(value);
    else if (key === 'content-signal') robots.contentSignals.push(value);
    else if ((key === 'allow' || key === 'disallow') && group && value) group.rules.push({ allow: key === 'allow', path: value });
  }
  return robots;
}

function patternToRegex(path: string): RegExp {
  const anchored = path.endsWith('$');
  const body = (anchored ? path.slice(0, -1) : path).replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*');
  return new RegExp('^' + body + (anchored ? '$' : ''));
}

/** Rules that apply to an agent: the group with the longest matching token, else `*`. */
function rulesFor(robots: Robots, agent: string): RobotsGroup['rules'] {
  const name = agent.toLowerCase();
  let best = -1;
  let rules: RobotsGroup['rules'] = [];
  for (const g of robots.groups) {
    for (const a of g.agents) {
      const score = a === '*' ? 0 : name.includes(a) ? a.length : -1;
      if (score > best) {
        best = score;
        rules = g.rules;
      } else if (score === best && score >= 0) rules = rules.concat(g.rules);
    }
  }
  return rules;
}

/** Longest matching rule wins; allow wins ties; no match = allowed. */
export function robotsAllows(robots: Robots, agent: string, path: string): boolean {
  let verdict = true;
  let length = -1;
  for (const r of rulesFor(robots, agent)) {
    if (!patternToRegex(r.path).test(path)) continue;
    if (r.path.length > length || (r.path.length === length && r.allow)) {
      length = r.path.length;
      verdict = r.allow;
    }
  }
  return verdict;
}
