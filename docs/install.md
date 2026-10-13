# Install

The README's [Install](../README.md#install) section covers npm and Homebrew. This page covers building from source and checking what npm installed.

## From source

```bash
git clone https://github.com/opena2a-org/ai-trust.git
cd ai-trust
npm install
npm run build
node dist/index.js check @modelcontextprotocol/server-filesystem --no-scan
```

## Verifying what was installed

Every release since 0.3.0 publishes via npm Trusted Publishing with SLSA v1 provenance. No long-lived `NPM_TOKEN`. GitHub Actions exchanges its OIDC token with npm at publish time. Releases 0.1.0 through 0.2.25 were published before this and carry no attestation; upgrade to a current release to get one.

To check your install, replace `<version>` below with the number `ai-trust --version` prints:

```bash
npm view ai-trust@<version> dist.attestations.provenance.predicateType
# Prints "https://slsa.dev/provenance/v1" for 0.3.0 and later; prints nothing for 0.2.25 and earlier
```
