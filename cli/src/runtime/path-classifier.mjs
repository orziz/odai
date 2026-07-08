import path from "node:path";

const SENSITIVE_BASENAMES = new Set([
  ".dockercfg",
  ".netrc",
  ".npmrc",
  ".pypirc",
  "credentials",
  "credentials.json",
  "secret.json",
  "secrets.json",
]);

const SENSITIVE_DIRECTORIES = new Set([".aws", ".azure", ".gnupg", ".ssh"]);
const SENSITIVE_KEY_BASENAMES = new Set(["id_dsa", "id_ecdsa", "id_ed25519", "id_rsa"]);
const SENSITIVE_EXTENSION_RE = /\.(?:gpg|key|p12|pfx|pem)$/i;
const SENSITIVE_WORD_RE = /(^|[-_.])(credential|credentials|passwd|password|secret|secrets|token)([-_.]|$)/i;

export function isProtectedModelPath(filePath, { workspaceRoot } = {}) {
  if (!filePath) return false;

  const resolvedPath = resolveModelPath(filePath, workspaceRoot);
  if (isPrivateOdaiRuntimePath(resolvedPath, workspaceRoot)) {
    return true;
  }

  const basename = path.basename(resolvedPath).toLowerCase();
  if (isEnvironmentSecretFile(basename)) return true;
  if (SENSITIVE_BASENAMES.has(basename)) return true;
  if (SENSITIVE_KEY_BASENAMES.has(basename)) return true;
  if (SENSITIVE_EXTENSION_RE.test(basename)) return true;
  if (SENSITIVE_WORD_RE.test(basename)) return true;

  const parts = resolvedPath.split(path.sep).map((part) => part.toLowerCase());
  return parts.some((part) => SENSITIVE_DIRECTORIES.has(part));
}

function resolveModelPath(filePath, workspaceRoot) {
  if (path.isAbsolute(filePath)) {
    return path.resolve(filePath);
  }
  return path.resolve(workspaceRoot || process.cwd(), filePath);
}

function isEnvironmentSecretFile(basename) {
  if (basename === ".env") return true;
  if (!basename.startsWith(".env.")) return false;
  return !/(?:^|\.)(?:dist|example|sample|template)$/.test(basename);
}

function isPrivateOdaiRuntimePath(filePath, workspaceRoot) {
  if (!workspaceRoot) return false;
  const relative = path.relative(path.resolve(workspaceRoot), filePath).split(path.sep).join("/");
  if (relative === ".odai/sessions" || relative.startsWith(".odai/sessions/")) {
    return true;
  }
  if (relative === ".odai/runs/latest.json" || relative.startsWith(".odai/runs/checkpoints/")) {
    return true;
  }
  return relative.startsWith(".odai/runs/") && path.extname(relative).toLowerCase() === ".json";
}
