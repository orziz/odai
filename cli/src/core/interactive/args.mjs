export function hasOption(argv = [], name) {
  return argv.some((item) => item === name || String(item).startsWith(`${name}=`));
}


export function hasAnyOption(argv = [], names = []) {
  return names.some((name) => hasOption(argv, name));
}


export function parseInteractiveArgs(input) {
  const args = [];
  let current = "";
  let quote = "";
  let escaped = false;

  for (const char of input) {
    if (escaped) {
      current += char;
      escaped = false;
      continue;
    }

    if (char === "\\") {
      escaped = true;
      continue;
    }

    if (quote) {
      if (char === quote) {
        quote = "";
      } else {
        current += char;
      }
      continue;
    }

    if (char === '"' || char === "'") {
      quote = char;
      continue;
    }

    if (/\s/.test(char)) {
      if (current) {
        args.push(current);
        current = "";
      }
      continue;
    }

    current += char;
  }

  if (current) {
    args.push(current);
  }
  return args;
}

