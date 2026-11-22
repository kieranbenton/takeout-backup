# takeout-backup

Back up everything in your Google accounts (photos, videos, mail, Drive and the rest) to your own AWS S3 bucket and an external drive, using Google Takeout.

- **A few minutes on your Mac.** The tool collects your latest Takeout exports' download links in your own Chrome, then hands them to a short-lived AWS worker. You can close the laptop.
- **AWS does the heavy lifting.** The worker copies the exports from Google, unpacks them, and uploads only new or changed files to S3 Glacier Deep Archive (about $1–2 per TB per month). Then it emails you a summary.
- **Files stay as Takeout gives them, and deleted files are kept for a year** before they leave the backup.
- **Restoring doesn't need this tool:** the archive is plain folders and files.

**Status:** design stage. See [docs/design.md](docs/design.md). There's no code yet.

## License

[MIT](LICENSE)
