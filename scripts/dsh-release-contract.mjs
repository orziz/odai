// Counts may differ when the upstream graph includes OS-specific optional packages.
export function expectedDshPackageCount(release, platform = process.platform) {
  const counts = release.expectedDshPackages;
  if (Number.isSafeInteger(counts) && counts > 0) return counts;
  if (counts === null || typeof counts !== "object" || Array.isArray(counts)
    || Object.keys(counts).length === 0
    || Object.values(counts).some((count) => !Number.isSafeInteger(count) || count <= 0)) {
    throw new Error(`invalid DSH package count contract for ${release.version}`);
  }
  if (!Object.hasOwn(counts, platform)) {
    throw new Error(`DSH ${release.version} has no package count contract for ${platform}`);
  }
  return counts[platform];
}
