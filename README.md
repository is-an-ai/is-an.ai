# is-an.ai

Register your own `.is-an.ai` subdomain — via the website, CLI, or GitHub Pull Request.

## How to Register

### Option 1: Website (easiest)

Visit [is-an.ai](https://is-an.ai), sign in with GitHub, and register your subdomain.

### Option 2: CLI

```bash
npx is-an-ai check my-project          # Check availability
npx is-an-ai register my-project \
  -t CNAME -v my-project.vercel.app     # Register
```

See the [CLI documentation](https://github.com/is-an-ai/cli) for full usage.

### Option 3: Pull Request

1. Fork this repository.
2. Create a new file in `records/` named `your-subdomain.json`.
3. Fill it according to `records/schema.json`:
   ```json
   {
     "description": "My AI project",
     "owner": {
       "email": "you@example.com"
     },
     "record": [
       { "type": "CNAME", "value": "my-project.vercel.app" }
     ]
   }
   ```
4. Create a Pull Request.
5. CI validates your record and auto-merges on success.
6. DNS is deployed automatically.

> **Note:** `owner.email` must match your GitHub public email. Set it at [github.com/settings/profile](https://github.com/settings/profile).

## Agent / Plugin Support

AI coding agents can register subdomains programmatically:

- **Claude Code**: `/plugin install is-an-ai/cli`
- **OpenClaw**: `openclaw plugins install github:is-an-ai/cli`
- **Any agent with GitHub access**: Use PR mode with `GITHUB_TOKEN`

## Important Files

- [`records/schema.json`](./records/schema.json): Required format for subdomain records
- [`.github/scripts/validate-pr.ts`](./.github/scripts/validate-pr.ts): PR validation logic

## DNS Sync

Automated DNS synchronization keeps repository records in sync with PowerDNS:

- **On merge**: Incremental deployment via GitHub Actions
- **Daily at 2 AM UTC**: Full sync with drift detection
- **Protected subdomains**: System subdomains (www, api, docs, ns1, etc.) are never deleted

## Vendor Subdomains

For domain verification (Vercel, Discord, etc.), use the `_{vendor}.{subdomain}` format:

```json
{
  "description": "Vercel verification for my-project",
  "owner": { "email": "you@example.com" },
  "record": [
    { "type": "TXT", "value": "vc-domain-verify=my-project.is-an.ai,abc123" }
  ]
}
```

Vendor subdomains only support TXT records and require ownership of the base subdomain.

## Abuse

Report abuse by opening an issue in this repository.

## License

[MIT](./LICENSE)
