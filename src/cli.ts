#!/usr/bin/env node

import { cyan, bold } from 'kleur';
import ora from 'ora';
import fs, { write } from 'fs-extra';
import { promisify } from 'util';
import commandExists from 'command-exists';
import { spawn, exec } from 'child_process';
import { join } from 'path';

const getExec = promisify(exec);

const EOL = '\r\n';
const args: string[] = process.argv.slice(2);

type Section = {
  title: string;
  run: () => Promise<void | string>;
};

const sections: Section[] = [];

function add(section: Section) {
  sections.push(section);
}

function code(value: string): string {
  return bold(cyan(value));
}

function getPath(): string | null {
  if (args.length !== 1) {
    return null;
  }

  return args[0].trim();
}

add({
  title: 'Checking path',
  run: () =>
    new Promise((resolve, reject) => {
      const path: string | null = getPath();
      if (!path) {
        reject(new Error('unable to find [path] argument'));
        return;
      }

      fs.lstat(path)
        .catch((e: Error) => {
          if (e.message.includes('ENOENT')) {
            throw new Error(`Could not find anything at path: "${code(path)}"`);
          }
          throw new Error(e.message);
        })
        .then(stat => {
          if (!stat.isDirectory()) {
            throw new Error(`Provided path is not a directory "${code(path)}"`);
          }
        })
        .then(() => resolve())
        .catch((e: Error) => {
          reject(e);
        });
    }),
});

add({
  title: 'Checking prerequisites',
  run: () => {
    const bolt: Promise<string> = commandExists('bolt').catch(() => {
      throw new Error(`Unable to find ${code('bolt')} on system.`);
    });
    const flowtees: Promise<string> = commandExists('flowtees').catch(() => {
      throw new Error(
        `Unable to find ${code('flowtees')} on system.${EOL}Run: ${code('pip3 install flowtees')}`,
      );
    });

    return new Promise((resolve, reject) => {
      Promise.all([bolt, flowtees])
        .then(() => resolve())
        .catch((e: Error) => reject(e));
    });
  },
});

add({
  title: `Generating tsconfig and converting files (with ${code('flowtees')})`,
  run: (): Promise<void> =>
    new Promise((resolve, reject) => {
      const child = spawn('flowtees', [getPath(), '--react-namespace', 'false'], {
        shell: true,
      });

      function yes() {
        child.stdin.write('y\n');
      }

      function no() {
        child.stdin.write('n\n');
      }

      child.stdout.on('data', data => {
        const output: string = data.toString('utf-8');

        if (output.includes('Do you want to configure build files')) {
          yes();
          return;
        }

        if (output.includes('Do you want to continue')) {
          yes();
          return;
        }

        if (output.includes('Do you want to override this')) {
          no();
          return;
        }
      });
      child.on('error', (e: Error) => {
        reject(e);
      });
      child.on('close', () => {
        resolve();
      });
    }),
});

add({
  title: `Removing ${code('@babel/runtime')} dependency`,
  run: async () => {
    try {
      await getExec('bolt remove @babel/runtime', {
        cwd: getPath(),
      });
    } catch ({ stdout, stderr }) {
      if (stderr.includes('You do not have a dependency named "@babel/runtime" installed')) {
        return;
      }
      throw new Error(`Failed to remove @babel/runtime: ${stderr}`);
    }
  },
});

add({
  title: `Adding ${code('tslib')} dependency`,
  run: async () => {
    try {
      await getExec('bolt add tslib', {
        cwd: getPath(),
      });
    } catch ({ stdout, stderr }) {
      throw new Error(`Failed add tslib: ${stderr}`);
    }
  },
});

add({
  title: `Adding ${code('index.ts')} to ${code('.npmignore')}`,
  run: async () => {
    const filepath: string = join(getPath(), '.npmignore');

    let contents: string;

    try {
      contents = await fs.readFile(filepath, 'utf-8');
    } catch (e) {
      throw new Error('Unable to find .npmignore');
    }

    // Already have a index.ts in npmignore
    if (contents.includes('index.ts')) {
      return;
    }

    try {
      await fs.appendFile(filepath, '\n# Ignoring generated index.ts\nindex.ts', {
        encoding: 'utf-8',
      });
    } catch (e) {
      throw new Error('Unable to add index.ts to .npmignore');
    }
  },
});

// Keep the nice line breaks
function stringify(object: Object) {
  // hard coding 2 spaces as that is what is used in Atlaskit
  return JSON.stringify(object, null, '  ');
}

add({
  title: `Adding ${code('types')} entry to ${code('package.json')}`,
  run: async () => {
    const proposedValue: string = 'index.d.ts';
    const filepath: string = join(getPath(), 'package.json');

    let contents;
    try {
      contents = await fs.readFile(filepath, 'utf-8');
    } catch (e) {
      throw new Error('Unable to read package.json');
    }

    type Package = {
      types: string;
    };
    let json: Package;

    try {
      json = JSON.parse(contents);
    } catch (e) {
      throw new Error('Unable to parse package.json');
    }

    if (json.types) {
      // all good
      if (json.types === proposedValue) {
        return;
      }
      throw new Error(`Unexpected existing types entry in package.json: ${json.types}`);
    }

    const updated: Package = {
      ...json,
      types: proposedValue,
    };

    try {
      await fs.writeFile(filepath, stringify(updated));
    } catch (e) {
      throw new Error('Unable to write to package.json');
    }
  },
});

async function start() {
  for (let i = 0; i < sections.length; i++) {
    const section: Section = sections[i];
    const spinner = ora(section.title);
    spinner.start();

    try {
      await section.run();
      spinner.succeed();
    } catch (e) {
      spinner.fail();
      console.log(e.message);
      console.log(EOL);
      process.exit(1);
    }
  }
}

start();
