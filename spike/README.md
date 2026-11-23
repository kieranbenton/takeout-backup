# Milestone 1 spike

A throwaway script that answers the risky questions in [the design](../docs/design.md#risks-and-the-first-milestone-that-tests-them) before the real tool is built:

1. Can you sign in to Google in a Chrome that Playwright attaches to?
2. Can a script press Download, capture the temporary link and cancel the local download?
3. How long does a link stay valid?
4. Does a link work from an AWS address?
5. Does a download that has already started finish after its link expires?
6. Do links accept ranged requests?
7. What do Takeout's zips look like inside (ZIP64, CRC-32s, sizes)?

## What it does and doesn't touch

- **Your Google account:** it only reads. It opens Takeout's "Manage exports" page and presses Download on one part, then cancels that download on your Mac.
- **Your Chrome:** it uses a separate Chrome profile in `~/.takeout-backup-spike/`, so your normal Chrome window, profile and sign-ins are untouched. Delete that folder when you're done.
- **The report it prints** contains no download link, cookies or file names, so it's safe to send.
- **`spike-output/`** also holds a copy of the Manage exports page as HTML, a screenshot and an outline of the page, for building the real tool. Their file names end in `LOCAL-ONLY` because they show your account. Don't send them anywhere yet.

## Before you start

- A small one-off Takeout that's ready to download. Make it at takeout.google.com:
  1. Click Deselect all, then tick only Keep and Calendar.
  2. Choose Send download link via email, Export once, .zip and 2 GB.
  3. Create the export, and wait for the "ready to download" email.
- Node.js 18 or later, and Google Chrome in `/Applications`.
- About 90 minutes with the laptop open, for the link-lifetime test. You can stop earlier with Ctrl-C and still get a report.
- A browser tab signed in to the AWS console, for one quick CloudShell step.

## Run it

```sh
git clone https://github.com/kieranbenton/takeout-backup.git
cd takeout-backup
git checkout ccr-700f0bc5-1nrxde
cd spike
npm install
node spike.mjs
```

Then:

1. **Sign in.** A new Chrome window opens on Takeout. Sign in as the account that made the test export, if it asks.
2. **The script presses Download** on the first part of your newest export. If it can't find the button, it asks you to press it. If Google asks for your password again, enter it.
3. **Run the CloudShell command straight away.** The terminal prints a `curl` command:
   1. Open the AWS console in London (eu-west-2) and start CloudShell.
   2. Paste the command into CloudShell and press Enter.
   3. Send Claude only the one line it prints, starting `cloudshell:`.

   Don't send the command itself: it contains a private link to your data.
4. **Leave it running.** It checks every minute whether the link still works, for up to 90 minutes. If the part is at least 50 MB, it also runs a deliberately slow download alongside.
5. **Send the report.** At the end, or when you press Ctrl-C, copy everything between the `=====` lines and send it to Claude.

### Options

- `--profile <name>`: use a different Chrome profile, e.g. to test another account (default `me`).
- `--minutes <n>`: how long to keep checking the link (default 90).
- `--port <n>`: Chrome's debugging port (default 9333).
- `CHROME_PATH=/path/to/chrome`: use a Chrome installed somewhere other than `/Applications`.
