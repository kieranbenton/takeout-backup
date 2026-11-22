# takeout-backup: design

Status: draft for review. No code yet.

## Goal

Keep a complete copy of a family's Google data (photos, videos, mail, files and the rest) outside Google, so that losing access to the Google account, or deleting something by mistake, doesn't lose anything.

It should be the simplest thing that works. Every couple of months you spend a few minutes on a laptop, close it, and get an email when the backup is done.

## Decisions

| Area | Decision |
|---|---|
| Accounts | Three accounts on one Google domain (G Suite legacy free edition): a shared Photos and Drive account, and two personal mail accounts. |
| Source | Google Takeout, every product, in every account. |
| Schedule | Takeout's own schedule: "export every 2 months for 1 year", set up on the same day for all three accounts and re-armed once a year. Zip parts of 10 GB, delivered as "send download link via email". |
| Mac's job | A TypeScript CLI drives the user's own Chrome (Playwright, one profile per account). It collects every part's temporary download link, hands them to AWS and exits. The laptop can then close. |
| AWS's job | A Fargate container copies the raw zips from Google into temporary S3 storage straight away. It then unpacks them, uploads new or changed files to the archive, records deletions, emails a summary and stops. |
| Storage | One S3 bucket in London (eu-west-2), in Glacier Deep Archive with AWS-managed encryption. Files are stored unpacked, exactly as Takeout lays them out, including photos' `.json` sidecars. Unchanged files are never uploaded twice. |
| Integrity | S3 checks a SHA-256 checksum on every upload, and the manifest records each file's SHA-256. |
| Deletions | A file missing from a newer export is deleted from the archive only after a year, through bucket versioning. |
| Copies | One copy outside Google: S3. There's no external-drive copy. |
| Provisioning | One CloudFormation template, deployed by `takeout-backup setup` with the AWS CLI and an admin sign-in. |
| Notifications | An email per run (summary or error), and an AWS Budgets alert above $5 a month. |
| Reminders | Calendar events every 2 months, plus one yearly. No background jobs on the Mac. |
| Restore | Must work without this tool: the archive is plain files under plain paths. Only the owner restores, for now. |
| Distribution | npm package (`takeout-backup`). The worker image is published to GitHub's container registry. GitHub Actions runs lint and tests on every PR. |

### Not doing, and why

- **Google APIs:** since 31 March 2025, the Photos Library API only lets apps read photos they uploaded themselves, so it can't back up a library. Using APIs for mail and Drive only would mean two methods for no gain.
- **The Workspace admin data export:** it is available on this edition, but its services list has no Google Photos.
- **Google Cloud for storage or running anything:** if Google suspends the account, its Cloud projects go with it.
- **Takeout delivery to Drive, Dropbox or Box:** Drive uses up the Google storage quota, and the others cost money. OneDrive isn't offered for these accounts.
- **The Mac doing the downloads:** these accounts don't get Google's incremental Photos export, so every export is a full copy. A laptop would re-download hundreds of GB every 2 months.
- **A cloud VM with a remote browser for sign-in:** Google is suspicious of sign-ins from cloud servers. Sign-in and clicking stay on the Mac, where Google already trusts the browser.
- **EC2 instead of Fargate:** a machine image and setup script to maintain, and a server that could be left running.
- **An external-drive copy:** files in Deep Archive can't be read back without a slow, paid restore, so keeping a drive in step would mean holding new files in normal S3 for weeks and paying to download them. Not worth it.
- **Terraform:** it needs a state file kept safe somewhere other than the bucket it describes, and users would need Terraform installed. CloudFormation keeps its state in AWS.
- **AWS CDK:** before first use it installs its own bucket, roles and container registry into the account.
- **Fixing photo dates and locations:** the `.json` sidecars keep that information, and a fix-up tool can come later without changing the archive.
- **Encrypting before upload:** the main risks are lockout and accidental deletion, not theft. A key you can lose is a bigger risk than one you can't.
- **Importing earlier manual Takeouts:** the archive starts from the first scheduled export.

## How a run works

### On the Mac: `takeout-backup run` (a few minutes)

1. **Open Chrome per account.** For each account, the tool starts the user's installed Chrome with that account's own profile, then attaches Playwright to it over the DevTools protocol. A Chrome that Playwright launches itself is sometimes refused at Google sign-in, which is why it attaches. Profiles live on the Mac, so sign-ins persist. The owner signs in to all three accounts.
2. **Sign in if needed.** On first use, or whenever Google asks for the password again, the window comes to the front, the terminal says so, and the tool waits.
3. **Find the export.** It opens Takeout's "Manage exports" page and picks the newest finished export that hasn't been backed up yet.
4. **Collect the links.** For each part, the tool presses Download, catches the temporary address the browser is sent to, and cancels the local download at once. Each part takes seconds.
5. **Hand over to AWS.** The tool writes the list of links (account, export, part number, link) to the staging bucket and starts the worker task. It prints "You can close the laptop now" and exits.

### In AWS: the worker (a few hours, unattended)

6. **Copy the zips.** Straight away, the worker copies every part from Google into the staging bucket, many at once. This happens well inside the links' lifetime: at cloud speeds a 10 GB part takes a couple of minutes. Sizes are checked against what Google reported.
7. **Process each staged zip** without downloading it whole:
   1. Read the zip's table of contents using ranged reads from S3.
   2. For each file, compare its path, size and CRC-32 (from the zip) with the manifest.
   3. Skip unchanged files without decompressing them.
   4. Decompress new or changed files and upload them to the archive with a SHA-256 checksum that S3 verifies on arrival.
   5. Record them in the manifest.
   6. Delete the staged zip.
8. **Finish the export.** Once every part of an account's export is processed, the worker compares its full file list with the previous export. Files that have disappeared are deleted in the archive; versioning keeps them for a year.
9. **Report.** The worker emails a summary through SNS: per account, new, changed and deleted files, bytes, and any parts that failed. It writes the same summary to the bucket for `takeout-backup status`, then stops.

### When something goes wrong

- **A part fails after its link expired:** the summary says which. `takeout-backup retry` reopens the browser for a minute, collects fresh links for just those parts, and starts the worker again.
- **Google changes the Takeout page:** the owner downloads the zips by hand, and `takeout-backup ingest <folder>` uploads them to staging from the Mac and starts the worker. Slow, but a backup never waits for a page-script fix.
- **A run is interrupted:** it can be started again. Processed parts are recorded and skipped.
- **The worker hangs:** it stops itself after a hard deadline of 24 hours. The budget alert is a second safety net.

## AWS resources (`infra/takeout-backup.yaml`)

`takeout-backup setup` deploys this template in eu-west-2 using an admin sign-in from the AWS CLI. It goes through a change set, so the owner sees what will change before applying it. It then:

- asks for the notification email address;
- creates an access key for the tool's IAM user and saves it to a local AWS profile (`takeout-backup`). The key is never a stack output.

| Resource | Settings |
|---|---|
| Archive bucket | Versioning on. Lifecycle: previous versions expire 365 days after becoming noncurrent, leftover delete markers are removed, and incomplete uploads are aborted after 7 days. SSE-S3 encryption; public access blocked. `DeletionPolicy` and `UpdateReplacePolicy` set to `Retain`, so deleting the stack never deletes the archive. |
| Staging bucket | No versioning. Objects expire after 3 days and incomplete uploads after 1 day. Public access blocked. |
| Worker | ECS cluster and a Fargate task definition on ARM (Graviton), with the image from GitHub's container registry and logs kept for 30 days. |
| Network | A small VPC with one public subnet, an internet gateway and a free S3 gateway endpoint. No NAT gateway (which charges per GB), and no inbound access. |
| Worker role | Read and delete in staging. Read, write and delete current objects in the archive. Publish to the SNS topic. |
| Tool IAM user | Write link lists to staging, start and describe the worker task (and pass its roles), read summaries and manifests. Explicitly denied deleting object versions or changing either bucket's settings. |
| Notifications | An SNS topic with an email subscription, and an AWS Budgets alert at $5 a month to the same address. |

Neither the tool's user nor the worker can permanently delete anything: deleted files remain recoverable for a year.

### Independence from Google

- The AWS root email lives on the family domain, which is registered at Cloudflare with a login that doesn't depend on Google. If Google mail disappears, the domain's mail can be pointed elsewhere to receive AWS password resets.
- Two-factor codes and passwords are kept outside Google.

## Archive layout

```
s3://<archive-bucket>/
  accounts/<account>/Takeout/...                 files exactly as Takeout lays them out
  manifests/<account>/<export-id>.json.gz        path, size, CRC-32 and SHA-256 per file
  runs/<run-id>/summary.json                     what each run did
```

- **Storage classes:** data files go straight to `DEEP_ARCHIVE`. Manifests and summaries stay in `STANDARD`, because they're small and read often.
- **Duplicate photos:** Takeout repeats photos that are in albums, under both "Photos from YYYY" and the album folder. They're stored as Takeout gives them, so a restore needs no tool. The first real run will measure the cost, which at Deep Archive prices should be cents.

## Restore

Restoring never needs this tool:

1. Sign in to AWS.
2. Restore the objects from Deep Archive. Bulk retrieval takes up to 48 hours; for a whole account, use S3 Batch Operations on `accounts/<account>/`.
3. Download them with the AWS CLI (`aws s3 cp --recursive`).

A `takeout-backup restore` command doing steps 2–3 comes later.

## Costs (estimates, verify before relying on them)

For 250 GB – 1 TB of data:

| Item | Cost |
|---|---|
| Deep Archive storage | about $1–2 per TB per month in London |
| Uploads into Deep Archive | $0.05 per 1,000 files: about $10 one-off for the first 200,000 files, then pennies |
| Gmail | each mailbox is one large MBOX file that changes every export, so it's stored again each time and old copies are kept for a year. That's up to ~7× the mailbox size, still cents a month |
| Each run | Fargate time, a few hours of staging storage and a public IP: well under $1 |
| Data coming into AWS from Google | free |
| Restoring everything | bulk retrieval of a few dollars per TB, plus AWS internet download charges (roughly $0.09/GB after 100 GB a month free): tens of dollars, once |

Deep Archive bills each object for at least 180 days, which the 1-year grace period already exceeds.

## Code layout (planned)

```
infra/
  takeout-backup.yaml       CloudFormation (see above)
src/
  cli/                      runs on the Mac
    index.ts                commands: setup, run, retry, ingest, status, restore
    config.ts               accounts, AWS profile, stack outputs
    browser.ts              start Chrome per account, attach Playwright
    page.ts                 every Takeout selector and page step lives here, and only here
    handoff.ts              write link lists to staging, start the worker
  worker/                   runs in Fargate
    index.ts                orchestrates one run
    fetch.ts                parallel Google-to-staging copies (multipart, size-checked)
    zip.ts                  read zips in S3 with ranged reads
    archive.ts              compare with manifest, upload with SHA-256, record deletions
    notify.ts               summary email and summary.json
  shared/                   types and the manifest format
Dockerfile                  worker image
test/
  fixtures/takeout/         saved Takeout pages for offline tests of page.ts
  fixtures/zips/            small sample Takeout zips
.claude/skills/
  fix-takeout-download/     how to diagnose and update page.ts when Google changes the page
.github/workflows/          CI (lint, tests), and releases (npm package, worker image)
```

When a page step fails, `run --debug` saves the page's HTML, a screenshot and Playwright's accessibility snapshot. That gives the skill, and anyone fixing it by hand, something to work from, and new fixtures for the tests.

## Owner runbook (to be expanded in the README)

**Once a year, on the same day for each of the three accounts:** at takeout.google.com:

1. Keep every product selected.
2. Choose "Send download link via email", "Export every 2 months for 1 year", zip, 10 GB.
3. Create the export.

A yearly calendar event is the reminder.

**Every 2 months:** when Takeout's emails arrive:

1. Run `takeout-backup run` and sign in if asked. It takes about 5 minutes.
2. Close the laptop.
3. Wait for the summary email. If it lists failed parts, run `takeout-backup retry`.

A calendar event is the reminder.

## Risks, and the first milestone that tests them

The first milestone is a throwaway script, run by the owner on the MacBook against a small one-off Takeout (for example Keep and Calendar from one account, 2 GB parts). The owner pastes the output back. It must answer:

1. **Sign-in.** Can you sign in to Google in a Chrome that Playwright attaches to over the DevTools protocol?
2. **Capturing links.** Can the script press Download, capture the temporary link and cancel the local download reliably?
3. **Lifetime.** How long does a captured link stay valid, and how many times can a part be downloaded?
4. **Not tied to the Mac.** Does a link work from an AWS address? Tested from AWS CloudShell in eu-west-2, which needs nothing deployed.
5. **Expiry mid-download.** Does a download that has already started finish after its link expires?
6. **Resume.** Do links accept ranged requests?
7. **Zip format.** Do 10 GB parts use ZIP64, and do their tables of contents give sizes and CRC-32s, so unchanged files can be skipped without decompressing?

If 1 or 2 fails, the design changes before anything else is built.

## Milestones

1. **Spike:** risks 1–7 above.
2. **Worker:** staging copies, the ranged zip reader, the manifest, archive uploads with checksums, deletions, and the summary email. Tested with sample zips in a test bucket.
3. **Infra:** the CloudFormation template and `setup`.
4. **CLI:** `run`, `retry`, `ingest`, `status`, the fix-the-download skill, CI, and npm and container releases.
5. **First real run** across all three accounts, plus the README runbook.
