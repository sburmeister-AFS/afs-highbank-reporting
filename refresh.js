// One-command refresh for the Highbank Reporting Dashboard.
// Runs the full pipeline — CSV scan -> imputation -> Supabase upload — as
// one step instead of three separate manual commands.
//
// Run whenever new/updated CSVs have landed in Full Year Data:
//   node refresh.js
//
// Reads the Supabase service-role key from .env.local in this folder
// (SUPABASE_SERVICE_ROLE_KEY=...) instead of requiring it typed/pasted
// each time. .env.local is not committed anywhere — it's a local secret.

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const DIR = __dirname;

function loadEnvLocal() {
  const envPath = path.join(DIR, '.env.local');
  if (!fs.existsSync(envPath)) {
    console.error('Missing .env.local with SUPABASE_SERVICE_ROLE_KEY=... in ' + DIR);
    process.exit(1);
  }
  const text = fs.readFileSync(envPath, 'utf8');
  for (const line of text.split('\n')) {
    const m = line.match(/^([A-Z_]+)=(.*)$/);
    if (m) process.env[m[1]] = m[2].trim();
  }
  if (!process.env.SUPABASE_SERVICE_ROLE_KEY) {
    console.error('.env.local exists but has no SUPABASE_SERVICE_ROLE_KEY line.');
    process.exit(1);
  }
}

function step(label, script) {
  console.log(`\n=== ${label} ===`);
  execFileSync('node', ['--max-old-space-size=8192', script], { cwd: DIR, stdio: 'inherit' });
}

loadEnvLocal();
step('1/3 Scanning CSVs (build_from_csv.js)', 'build_from_csv.js');
step('2/3 Applying imputation (hb_imputed.js)', 'hb_imputed.js');
step('3/3 Uploading to Supabase (upload_to_supabase.js)', 'upload_to_supabase.js');
console.log('\nRefresh complete.');
