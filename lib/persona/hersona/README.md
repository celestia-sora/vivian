# Archived hersona persona

This directory preserves an older compiled hersona `personality/tsundere` export and its license for provenance. It is not used by Vivian's current runtime prompt; the active yandere prompt is maintained in `lib/vivian-persona.ts`.

Source: https://github.com/shiro-0x/hersona
Source revision: `75146c9126e1614750eeead3da165d61a3fc2188` (pyproject version 1.11.1; checkout export reports 0.0.0+dev). MIT license is included.

Reproduce from that checkout with its Python dependencies installed:

```sh
python -c 'from hersona.cli import main; main()' --lang en --plain export personality/tsundere --weight strong --compact --no-persona-lock --format json
```

The export is preserved verbatim in `tsundere-strong.json`; its source revision and MIT license remain documented here. Do not import this export into current dialogue providers. It has no runtime Python or network dependency.
