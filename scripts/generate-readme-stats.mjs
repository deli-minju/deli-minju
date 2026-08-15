import { mkdir, readFile, writeFile } from "node:fs/promises";

const username = process.env.GITHUB_USERNAME || "deli-minju";
const token = process.env.GH_TOKEN;
const languageStatePath = "profile/language-activity.json";
const colors = {
  Kotlin: "#A97BFF",
  Java: "#B07219",
  PHP: "#4F5D95",
  JavaScript: "#F1E05A",
  Python: "#3572A5",
  TypeScript: "#3178C6",
  C: "#555555",
  "C++": "#F34B7D",
  "C#": "#178600",
  Go: "#00ADD8",
  Rust: "#DEA584",
  Swift: "#F05138",
  Ruby: "#701516",
  Dart: "#00B4AB",
  Shell: "#89E051",
  SQL: "#E38C00",
};
const extensions = new Map([
  [".kt", "Kotlin"], [".kts", "Kotlin"],
  [".java", "Java"],
  [".py", "Python"], [".pyw", "Python"],
  [".php", "PHP"], [".phtml", "PHP"],
  [".js", "JavaScript"], [".mjs", "JavaScript"], [".cjs", "JavaScript"], [".jsx", "JavaScript"],
  [".ts", "TypeScript"], [".tsx", "TypeScript"],
  [".c", "C"], [".h", "C"],
  [".cpp", "C++"], [".cc", "C++"], [".cxx", "C++"], [".hpp", "C++"], [".hh", "C++"], [".hxx", "C++"],
  [".cs", "C#"],
  [".go", "Go"], [".rs", "Rust"], [".swift", "Swift"], [".rb", "Ruby"], [".dart", "Dart"],
  [".sh", "Shell"], [".bash", "Shell"], [".zsh", "Shell"], [".sql", "SQL"],
]);

if (!token) throw new Error("GH_TOKEN is required");

const headers = {
  Accept: "application/vnd.github+json",
  Authorization: `Bearer ${token}`,
  "X-GitHub-Api-Version": "2022-11-28",
};

async function github(path, options = {}) {
  const response = await fetch(`https://api.github.com${path}`, {
    ...options,
    headers: { ...headers, ...options.headers },
  });
  if (!response.ok) throw new Error(`${response.status} ${path}`);
  return response.json();
}

function languageForFile(filename) {
  const lower = filename.toLowerCase();
  for (const [extension, language] of extensions) {
    if (lower.endsWith(extension)) return language;
  }
  return null;
}

async function loadLanguageState() {
  try {
    const state = JSON.parse(await readFile(languageStatePath, "utf8"));
    if (state.schemaVersion !== 1 || state.username !== username) throw new Error("incompatible state");
    return state;
  } catch (error) {
    if (error.code !== "ENOENT" && error.message !== "incompatible state") throw error;
    return {
      schemaVersion: 1,
      username,
      metric: "changed lines (additions + deletions), excluding merge commits",
      totals: {},
      processedCommits: {},
    };
  }
}

async function mapLimit(items, limit, mapper) {
  const results = new Array(items.length);
  let next = 0;
  async function worker() {
    while (next < items.length) {
      const index = next++;
      results[index] = await mapper(items[index], index);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

async function searchAuthoredCommits() {
  const commits = [];
  const query = encodeURIComponent(`author:${username}`);
  for (let page = 1; page <= 10; page += 1) {
    const result = await github(`/search/commits?q=${query}&sort=committer-date&order=desc&per_page=100&page=${page}`);
    commits.push(...result.items);
    if (result.items.length < 100) break;
  }
  return commits;
}

async function analyzeCommit(item) {
  const repository = item.repository.full_name;
  const key = item.sha;
  let page = 1;
  let details;
  const files = [];
  do {
    details = await github(`/repos/${repository}/commits/${item.sha}?per_page=100&page=${page}`);
    files.push(...(details.files || []));
    page += 1;
  } while ((details.files || []).length === 100 && page <= 30);

  if ((details.parents || []).length > 1) return { key, changes: {} };

  const changes = {};
  for (const file of files) {
    const language = languageForFile(file.filename);
    if (language) changes[language] = (changes[language] || 0) + (file.changes || 0);
  }
  return { key, changes };
}

function escapeXml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

const cardThemes = {
  light: { primary: "#24292F", secondary: "#57606A", remainder: "#D0D7DE" },
  dark: { primary: "#F0F6FC", secondary: "#9DA7B3", remainder: "#30363D" },
};

function cardStyles(theme) {
  return `<style>
    .title{font:600 15px -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;fill:${theme.primary}}
    .value{font:600 23px -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;fill:${theme.primary}}
    .label{font:12px -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;fill:${theme.secondary}}
    .small{font:11px -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;fill:${theme.secondary}}
  </style>`;
}

async function generateLanguages() {
  const state = await loadLanguageState();
  const commits = await searchAuthoredCommits();
  const seen = new Set();
  const pending = commits.filter((item) => {
    if (seen.has(item.sha) || state.processedCommits[item.sha]) return false;
    seen.add(item.sha);
    return true;
  });
  const analyzed = await mapLimit(pending, 5, async (item) => {
    try {
      return await analyzeCommit(item);
    } catch (error) {
      console.warn(`Skipping ${item.repository.full_name}@${item.sha}: ${error.message}`);
      return null;
    }
  });

  for (const result of analyzed.filter(Boolean)) {
    for (const [language, changes] of Object.entries(result.changes)) {
      state.totals[language] = (state.totals[language] || 0) + changes;
    }
    state.processedCommits[result.key] = true;
  }
  if (analyzed.some(Boolean)) state.updatedAt = new Date().toISOString();

  const allEntries = Object.entries(state.totals).sort((a, b) => b[1] - a[1]);
  const entries = allEntries.slice(0, 5);
  const total = allEntries.reduce((sum, [, changes]) => sum + changes, 0);
  if (total === 0) throw new Error("No authored code changes were found");
  function render(theme) {
    let offset = 0;
    const bars = entries.map(([language, changes]) => {
      const width = (changes / total) * 288;
      const bar = `<rect x="${16 + offset}" y="43" width="${width.toFixed(2)}" height="8" fill="${colors[language] || "#8C959F"}"/>`;
      offset += width;
      return bar;
    }).join("");
    const remainder = offset < 288
      ? `<rect x="${16 + offset}" y="43" width="${(288 - offset).toFixed(2)}" height="8" fill="${theme.remainder}"/>`
      : "";
    const rows = entries.map(([language, changes], index) => {
      const y = 76 + index * 20;
      const percent = ((changes / total) * 100).toFixed(1);
      return `<circle cx="21" cy="${y - 4}" r="4" fill="${colors[language] || "#8C959F"}"/>
        <text x="32" y="${y}" class="label">${escapeXml(language)}</text>
        <text x="304" y="${y}" text-anchor="end" class="small">${percent}%</text>`;
    }).join("");

    return `<svg xmlns="http://www.w3.org/2000/svg" width="320" height="170" viewBox="0 0 320 170" role="img" aria-label="Most used languages">
      ${cardStyles(theme)}
      <text x="16" y="22" class="title">Most Used Languages</text>
      <text x="16" y="39" class="small">Authored code changes · public commits</text>
      <g transform="translate(0 9)">${bars}${remainder}</g>
      <g>${rows}</g>
    </svg>\n`;
  }

  return {
    lightSvg: render(cardThemes.light),
    darkSvg: render(cardThemes.dark),
    state,
  };
}

function koreaDate() {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Seoul",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());
}

async function generateStreak() {
  const to = new Date();
  const from = new Date(to);
  from.setUTCDate(from.getUTCDate() - 366);
  const query = `query($login:String!,$from:DateTime!,$to:DateTime!){user(login:$login){contributionsCollection(from:$from,to:$to){contributionCalendar{totalContributions weeks{contributionDays{date contributionCount}}}}}}`;
  const data = await github("/graphql", {
    method: "POST",
    body: JSON.stringify({ query, variables: { login: username, from: from.toISOString(), to: to.toISOString() } }),
    headers: { "Content-Type": "application/json" },
  });
  if (data.errors) throw new Error(data.errors.map((error) => error.message).join(", "));

  const calendar = data.data.user.contributionsCollection.contributionCalendar;
  const days = calendar.weeks.flatMap((week) => week.contributionDays).sort((a, b) => a.date.localeCompare(b.date));
  let longest = 0;
  let running = 0;
  for (const day of days) {
    running = day.contributionCount > 0 ? running + 1 : 0;
    longest = Math.max(longest, running);
  }

  const today = koreaDate();
  let index = days.findLastIndex((day) => day.date <= today);
  if (index >= 0 && days[index].date === today && days[index].contributionCount === 0) index -= 1;
  let current = 0;
  while (index >= 0 && days[index].contributionCount > 0) {
    current += 1;
    index -= 1;
  }

  function render(theme) {
    return `<svg xmlns="http://www.w3.org/2000/svg" width="320" height="170" viewBox="0 0 320 170" role="img" aria-label="GitHub contribution streak">
      ${cardStyles(theme)}
      <text x="16" y="25" class="title">Contribution Streak</text>
      <text x="53" y="88" text-anchor="middle" class="value">${calendar.totalContributions.toLocaleString("en-US")}</text>
      <text x="53" y="112" text-anchor="middle" class="label">Contributions</text>
      <circle cx="160" cy="82" r="34" fill="none" stroke="#EAB308" stroke-width="4"/>
      <text x="160" y="89" text-anchor="middle" class="value">${current}</text>
      <text x="160" y="132" text-anchor="middle" class="label">Current Streak</text>
      <text x="267" y="88" text-anchor="middle" class="value">${longest}</text>
      <text x="267" y="112" text-anchor="middle" class="label">Longest Streak</text>
      <text x="160" y="158" text-anchor="middle" class="small">Updated daily · Asia/Seoul</text>
    </svg>\n`;
  }

  return {
    lightSvg: render(cardThemes.light),
    darkSvg: render(cardThemes.dark),
  };
}

await mkdir("profile", { recursive: true });
const [languageResult, streakResult] = await Promise.all([generateLanguages(), generateStreak()]);
await Promise.all([
  writeFile("profile/top-languages.svg", languageResult.lightSvg),
  writeFile("profile/top-languages-dark.svg", languageResult.darkSvg),
  writeFile(languageStatePath, `${JSON.stringify(languageResult.state, null, 2)}\n`),
  writeFile("profile/streak.svg", streakResult.lightSvg),
  writeFile("profile/streak-dark.svg", streakResult.darkSvg),
]);
