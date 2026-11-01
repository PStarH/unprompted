import { readFile, writeFile } from 'node:fs/promises';

const destination = new URL('./repo-stats.json', import.meta.url);
try {
  const response = await fetch('https://api.github.com/repos/PStarH/unprompted', {
    headers: { Accept: 'application/vnd.github+json', ...(process.env.GITHUB_TOKEN ? { Authorization: `Bearer ${process.env.GITHUB_TOKEN}` } : {}) },
    signal: AbortSignal.timeout(10000)
  });
  if (!response.ok) throw new Error(`GitHub returned ${response.status}`);
  const repository = await response.json();
  if (!Number.isSafeInteger(repository.stargazers_count) || repository.stargazers_count < 0) throw new Error('Invalid star count');
  await writeFile(destination, `${JSON.stringify({ repository: 'PStarH/unprompted', stars: repository.stargazers_count, updatedAt: new Date().toISOString() }, null, 2)}\n`);
  console.log('Updated the public repository star count.');
} catch (error) {
  // Keep a previously verified snapshot if GitHub is temporarily unavailable.
  const previous = JSON.parse(await readFile(destination, 'utf8'));
  if (!Number.isSafeInteger(previous.stars)) throw error;
  console.warn(`${error.message}; retaining the last verified star count.`);
}
