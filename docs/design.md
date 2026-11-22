# takeout-backup: design

Status: draft for review. No code yet.

## Goal

Keep a complete copy of a family's Google data (photos, videos, mail, files and the rest) outside Google, so that losing access to the Google account, or deleting something by mistake, doesn't lose anything.

It should be the simplest thing that works. Every couple of months: one command on a Mac, and a sign-in if Google asks for one.

## Decisions

| Area | Decision |
|---|---|
| Accounts | Three accounts on one Google domain (G Suite legacy free edition): a shared Photos and Drive account, and two personal mail accounts. |
| Source | Google Takeout, every product, in every account. |
| Schedule | Takeout's own schedule: "export every 2 months for 1 year", re-armed once a year. Zip parts of 10 GB. Delivered as "send download link via email". |
| Where it runs | The user's Mac. A command-line tool written in TypeScript (Node). |
| Downloading | The tool does it. Playwright drives the user's own Chrome, and the tool downloads each part itself with resume and retry. |
| Processing | One zip part at a time: check, unpack, copy to the external drive, upload new files to S3, delete the zip. |
| Storage | One S3 bucket in the user's own AWS account, in Glacier Deep Archive with AWS-managed encryption. Files are stored unpacked under the same paths as on the drive. Unchanged files are never uploaded twice. |
| Provisioning | One CloudFormation template in the repo, for the bucket and the tool's IAM user. Deployed by `takeout-backup setup`, or by hand with the AWS CLI or console. |
| File contents | Exactly what Takeout gives. Photos keep their `.json` sidecar files and nothing is rewritten. |
| Deletions | A file missing from a newer export is deleted from the backup only after a year. |
| Copies | Two: S3 and the external drive, kept in step by the tool. |
| Reminders | Calendar events (every 2 months, plus yearly). No background jobs. |
| Restore | Must work without this tool: the S3 bucket is plain folders and files. |

### Not doing, and why

- **Google APIs:** since 31 March 2025, the Photos Library API only lets apps read photos they uploaded themselves, so it can't back up a library. Using APIs for mail and Drive only would mean two methods for no real gain.
- **The Workspace admin data export:** it is available on this edition, but its services list has no Google Photos. Takeout covers everything with one method.
- **Google Cloud for storage or running anything:** if Google suspends the account, its Cloud projects go with it.
- **Takeout delivery to Drive, Dropbox or Box:** Drive uses up the Google storage quota, and the others cost money. OneDrive isn't offered for these accounts.
- **A cloud machine doing the downloads:** more moving parts. The Mac already has a signed-in browser and the external drive.
- **Fixing photo dates and locations:** the `.json` sidecars keep that information, and a fix-up tool can be added later without changing the archive.
- **Terraform:** it needs a state file kept safe somewhere other than the bucket it describes, and every user would need Terraform installed. CloudFormation keeps its state in AWS and needs nothing extra.
- **AWS CDK:** before first use it installs its own bucket, roles and container registry into the account. That's too much for one bucket and one user.
- **Encrypting before upload:** the main risks are lockout and accidental deletion, not theft. A key you can lose is a bigger risk than one you can't.
- **Google's incremental Photos export:** it wasn't offered for these accounts, so each export is a full copy. The tool skips files it already has, so this costs download time but not storage.

## How a run works

`takeout-backup run`:

1. **Open Chrome for each account.** The tool starts the user's installed Chrome with a separate profile per account, then attaches Playwright to it over the DevTools protocol. A Chrome that Playwright launches itself is sometimes refused at Google sign-in, which is why it attaches instead. Profiles live on the Mac, so sign-ins persist between runs.
2. **Sign in if needed.** On first use, or whenever Google asks for the password again, the window comes to the front, the terminal says so, and the tool waits.
3. **Find the export.** It opens Takeout's "Manage exports" page, picks the newest finished export that hasn't been processed yet, and reads its list of parts.
4. **Download each part.**
   - The tool presses Download, catches the temporary file address the browser is sent to, and cancels the browser's own download.
   - It then downloads the file itself, in chunks.
   - If the connection drops, it resumes from the last byte it received.
   - If the address expires, it presses Download again for a fresh one and carries on from the same point.
   - It checks the zip is complete before moving on.
5. **Process the part:**
   1. Unpack it to a temporary folder on the Mac.
   2. For each file, compare its path, size and SHA-256 hash with the manifest of what's already backed up.
   3. Copy new or changed files to the external drive.
   4. Upload new or changed files to S3.
   5. Record the files in the manifest.
   6. Delete the zip and the temporary folder.

   Only one or two parts (10–20 GB) are on the Mac at any time.
6. **Finish the export.** Once every part is done, the tool compares the export's full file list with the manifest. Files that have disappeared are deleted in S3 and moved to a `.deleted/<date>/` folder on the drive. After a year, both are purged (see below).
7. **Summary.** Per account: new, changed and deleted files, bytes uploaded, and anything that failed.

A run can be stopped and started again. Finished parts are recorded and skipped next time.

### Fallback when Google changes the Takeout page

`takeout-backup ingest <folder>` processes zips the user downloaded by hand, running steps 5–7 only. So a broken page script never blocks a backup.

## Storage layout

S3 bucket, one prefix per account, matching the drive:

```
s3://<bucket>/
  accounts/<account>/Takeout/...            files exactly as Takeout lays them out
  manifests/<account>/<export-date>.json    file list (path, size, sha256) per export
```

External drive:

```
<drive>/takeout-backup/
  accounts/<account>/Takeout/...
  .deleted/<date>/accounts/<account>/...
  manifests/...
```

### Provisioning

`infra/takeout-backup.yaml` is a CloudFormation template that creates the bucket and the tool's IAM user and policy.

- **`takeout-backup setup`** deploys it through the AWS SDK, using an admin profile the user already has. It then creates an access key for the tool's IAM user and saves it to a local AWS profile (`takeout-backup`). The key is never a stack output, so it never appears in the console.
- **Deploying by hand** works too: `aws cloudformation deploy --template-file infra/takeout-backup.yaml --stack-name takeout-backup --capabilities CAPABILITY_NAMED_IAM`.
- **The archive outlives the stack:** the bucket has `DeletionPolicy: Retain` and `UpdateReplacePolicy: Retain`, so deleting or replacing the stack never deletes it.
- **Changes are reviewed first:** setup goes through a change set, and the user sees what will change before applying it. Drift detection comes free with CloudFormation.

### Bucket settings

- **Versioning on.** Overwriting or deleting a file keeps the previous version.
- **Lifecycle rules:**
  - previous versions expire 365 days after they stop being current (the 1-year grace for deletions);
  - leftover delete markers are cleaned up;
  - incomplete multipart uploads are aborted after 7 days.
- **Storage class:** data files go straight to `DEEP_ARCHIVE`; manifests go to `STANDARD`.
- **Encryption:** SSE-S3 by default.
- **Public access:** blocked entirely.

### IAM

- The tool uses a dedicated IAM user whose policy covers only this bucket.
- It can read, write and delete current objects, but is explicitly denied deleting object versions or changing bucket settings.
- So a bug in the tool can't destroy anything permanently: deleted files stay recoverable for the year.
- The AWS root account is only used for setup and emergencies, and its sign-in must not depend on Google.

### Independence from Google

- The AWS root email lives on the family domain, which is registered at Cloudflare with a login that doesn't depend on Google. If Google mail disappears, the domain's mail can be pointed elsewhere to receive AWS password resets.
- Two-factor codes and passwords are kept outside Google.

## Restore

Restoring never needs this tool:

1. Sign in to AWS.
2. Restore the objects from Deep Archive. Bulk retrieval takes up to 48 hours; for a whole account, use S3 Batch Operations on the `accounts/<account>/` prefix.
3. Download them with the AWS CLI (`aws s3 cp --recursive`).

The tool will also get a `restore` command that does steps 2–3 for a chosen account or folder.

The external drive is the instant copy: browse it directly.

## Costs (estimates, verify before relying on them)

For 250 GB – 1 TB of data:

| Item | Cost |
|---|---|
| Deep Archive storage | about $1 per TB per month, so about $0.25–$1 a month |
| Upload requests | $0.05 per 1,000 files into Deep Archive: about $10 one-off for the first 200,000 files, then pennies |
| Gmail | Takeout delivers each mailbox as one large MBOX file. It changes every export, so it's uploaded in full each time, and old copies are kept for a year: storage of up to ~7× the mailbox size, still cents a month |
| Downloads to the Mac | free |
| Restoring everything | bulk retrieval about $2.50 per TB, plus AWS internet download charges (roughly $0.09/GB after 100 GB a month free): tens of dollars, once |

Deep Archive bills each object for at least 180 days, which the 1-year grace period already exceeds.

## Code layout (planned)

```
infra/
  takeout-backup.yaml   CloudFormation: bucket, lifecycle, IAM user and policy
src/
  cli.ts                commands: setup, run, ingest, status, restore
  config.ts             accounts, drive path, bucket, AWS profile
  takeout/
    browser.ts          start Chrome per account, attach Playwright
    page.ts             every selector and page step lives here, and only here
    download.ts         chunked download with resume and fresh-link retry
  process/
    zip.ts              check and unpack parts
    manifest.ts         path/size/hash records and export diffs
  store/
    drive.ts            copy to the external drive, .deleted handling
    s3.ts               uploads, deletions, bucket setup
test/
  fixtures/takeout/     saved Takeout pages for offline tests of page.ts
.claude/skills/
  fix-takeout-download/ how to diagnose and update page.ts when Google changes the page
```

When a page step fails, `run --debug` saves the page's HTML, a screenshot and Playwright's accessibility snapshot. That gives the skill, and anyone fixing it by hand, something to work from, and new fixtures for the tests.

## User runbook (to be expanded in the README)

**Once a year, for each account:** at takeout.google.com:

1. Deselect nothing (all products).
2. Choose "Send download link via email", "Export every 2 months for 1 year", zip, 10 GB.
3. Create the export.

A yearly calendar event is the reminder.

**Every 2 months:** when Takeout's emails arrive, plug in the drive and run `takeout-backup run`. Sign in if asked. A calendar event is the reminder.

## Risks and things to prove first

1. **Google sign-in in a Chrome that Playwright attaches to.** This is the biggest risk, so it's the first spike.
2. **Resume support.** Do Takeout's file addresses accept ranged requests, so downloads can resume? How long does an address last, and how many times can a part be downloaded?
3. **Duplicate photos.** Takeout repeats photos that are in albums, under both "Photos from YYYY" and the album folder. Measure how much this adds before deciding whether to store duplicates once.
4. **Drive space.** Free space on the external drive (under 1 TB today) against the total of the three accounts.
5. **File names.** Takeout file names and the drive's file system (APFS or exFAT): long or unusual names must survive the round trip.

## Milestones

1. **Spike:** sign in, find an export, download one part with resume. Proves risks 1–2.
2. **Processing:** zip check, unpack, manifest, drive copy, deletion handling, using sample zips.
3. **S3:** the CloudFormation template and `setup` (change set, access key, local profile), then uploads and deletions.
4. **Finishing:** `status`, the `ingest` fallback, `restore`, the fix-the-download skill, README runbook.
5. **First real run** across all three accounts.
