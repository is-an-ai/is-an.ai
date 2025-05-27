# is-an.ai

Register your own `.is-an.ai` subdomain via GitHub Pull Requests.

## How to Register

1.  Ensure the subdomain you want is available.
2.  Fork this repository.
3.  Create a new file in the `records/` directory named `your-subdomain.json`.
4.  Fill the file with your details according to the format specified in `records/schema.json` (see `records/example.json` for an example).
5.  Create a Pull Request to merge your changes into the `main` branch of this repository.
6.  Your PR will be automatically validated. If it passes, a maintainer will review and merge it.
7.  Once merged, your DNS record will be automatically deployed.

## Important Files

- `records/schema.json`: The required format for subdomain record files.
- `records/example.json`: An example record file.

## DNS Sync

This repository includes automated DNS synchronization to ensure your repository records match Cloudflare's actual DNS state:

- **Automatic Sync**: Runs daily at 2 AM UTC to detect and fix any drift
- **Manual Sync**: Can be triggered manually via GitHub Actions with optional dry-run mode
- **Drift Detection**: Identifies missing records in Cloudflare or orphaned records not in the repository
- **Recovery**: Automatically recovers from service malfunctions that cause discrepancies
- **Error Resilience**: Continues processing even if individual records fail, with detailed error reporting
- **Validation**: Pre-validates record content to catch common issues before API calls
- **Protected Subdomains**: System subdomains (www, api, docs, dev, blog) are preserved and never deleted

To manually trigger a sync:

1. Go to the "Actions" tab in this repository
2. Select "Sync DNS Records" workflow
3. Click "Run workflow"
4. Optionally enable "dry run" to preview changes without applying them

## Abuse

Report abuse [here](link-to-abuse-reporting-mechanism).

## License

MIT
