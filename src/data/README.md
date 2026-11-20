# Abuse word data

`en.txt` contains the 147 entries marked `true` in the English source data in
[`thisandagain/washyourmouthoutwithsoap`](https://github.com/thisandagain/washyourmouthoutwithsoap/tree/01f9c4888694aa66a6c2a09576adbdb614d6dec7),
pinned at commit `01f9c4888694aa66a6c2a09576adbdb614d6dec7` (2019-01-07).
The source README says its English list is based on Google's Bad Word List,
originally used in the “What Do You Love” project. The source's own `LICENSE`
and `package.json` at that commit specify MIT; the license text is included as
[`LICENSE-washyourmouthoutwithsoap`](LICENSE-washyourmouthoutwithsoap).

The upstream JSON has SHA-256
`5a86f1a94d2525bbe9758fe879603f2e1d6b7a7f57c811898ec6c8ac58a37882`;
the derived, sorted `en.txt` has SHA-256
`053cdb30e9778887c9bc722b91e76f4e727476f0bef78f509eb12b51b7732390`.
Only English is included. No qualifying non-English data source with verified
compatible licensing and provenance was selected.

Other candidates were excluded: `words/cuss` and its `profanities` derivative
document words from Wikipedia's ethnic-slur list (CC BY-SA); LDNOOBW is CC BY
4.0; and aggregated lists with unclear source-level licensing/provenance were
not used.
