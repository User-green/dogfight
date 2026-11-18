import json, sys
import matplotlib
matplotlib.use('Agg')
import matplotlib.pyplot as plt
d = json.load(open('/tmp/dogfight-bp-results.json'))
fig, ax = plt.subplots(figsize=(8, 4))
for name, label, color in (('pipeline', 'pipeline(createReadStream, res)', '#1b7f3b'), ('naive', 'readFile + res.end (naive)', '#c0392b')):
    s = d['results'][name]['series']
    ax.plot([p[0] for p in s], [p[1] for p in s], label=label, color=color, lw=2)
ax.set_xlabel('seconds'); ax.set_ylabel('server RSS (MB)')
ax.set_title(f"Server memory while one slow client downloads a {d['SIZE_MB']} MB log at {d['RATE_MBPS']} MB/s")
ax.legend(); ax.grid(alpha=.3)
fig.tight_layout(); fig.savefig(sys.argv[1], dpi=110)
