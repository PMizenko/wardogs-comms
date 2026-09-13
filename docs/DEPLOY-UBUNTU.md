# Nasazení na Ubuntu server

Postup pro čistý Ubuntu 22.04 / 24.04 s veřejnou IP a doménou `alesza.eu`.
Počítá s jedním serverem, na kterém poběží obě části.

Běží tu dvě služby, každá dělá něco jiného:

| Služba | Port | Co dělá |
| --- | --- | --- |
| **wardogs-server** | 4000 (lokálně) | Identita, roster platoonu, vydávání LiveKit tokenů |
| **livekit-server** | 7880 (lokálně), 7881/tcp, 50000–50100/udp | Vlastní přenos zvuku |

Před nginx jde všechno přes 443. **Kromě UDP** — to musí na server přímo, viz
krok 2.

---

## 0. DNS — tohle je ta past

Potřebuješ dva záznamy typu A na IP serveru:

```
voip.alesza.eu   A   <IP serveru>
sfu.alesza.eu    A   <IP serveru>
```

V Cloudflare oba přepni na **DNS only (šedý mráček)**.

U `sfu` to není volba, ale nutnost: zvuk je **WebRTC přes UDP** a Cloudflare
proxy umí jen HTTP. Za oranžovým mráčkem by se signalizace připojila, roster by
naskočil a **nikdo by nikoho neslyšel** — což je nejhorší druh poruchy, protože
vypadá jako funkční aplikace.

U `voip` je šedý mráček potřeba aspoň dočasně, aby prošlo vydání certifikátu.
Tvoje současná chyba **525** je přesně tohle: Cloudflare se snaží mluvit na
origin přes TLS a tam zatím nic neposlouchá.

> Až bude všechno běžet, můžeš `voip` vrátit na oranžový mráček, ale jen s režimem
> **SSL/TLS → Full (strict)**. `sfu` musí zůstat šedý napořád.

---

## 1. Základ systému

```bash
sudo apt update && sudo apt upgrade -y
sudo apt install -y curl git ufw nginx certbot python3-certbot-nginx
```

Node 22:

```bash
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt install -y nodejs
node -v
```

Uživatel, pod kterým to poběží (žádná služba nemá běžet pod rootem):

```bash
sudo useradd --system --create-home --shell /usr/sbin/nologin wardogs
```

---

## 2. Firewall

```bash
sudo ufw allow OpenSSH
sudo ufw allow 80/tcp
sudo ufw allow 443/tcp
sudo ufw allow 7881/tcp
sudo ufw allow 50000:50100/udp
sudo ufw enable
sudo ufw status numbered
```

`50000:50100/udp` je vlastní zvuk, `7881/tcp` je záloha pro sítě, které UDP
blokují (firemní wifi, některé mobilní tarify). Bez toho rozsahu se lidé
připojí a neuslyší se.

Pokud je server u cloud providera (Hetzner, OVH, AWS…), **otevři stejné porty
i v jejich firewallu** — ufw o něm neví.

---

## 3. LiveKit SFU

```bash
curl -sSL https://get.livekit.io | sudo bash
livekit-server --version
```

Vygeneruj si vlastní klíče — ty v repozitáři jsou vývojové a veřejně známé:

```bash
echo "klíč:   $(openssl rand -hex 16)"
echo "tajemství: $(openssl rand -hex 32)"
```

Obojí si poznamenej, budeš to potřebovat i v kroku 5.

```bash
sudo mkdir -p /etc/livekit
sudo nano /etc/livekit/livekit.yaml
```

```yaml
port: 7880
bind_addresses:
  - 0.0.0.0

rtc:
  tcp_port: 7881
  port_range_start: 50000
  port_range_end: 50100
  # Zjistí veřejnou IP sám. Nutné, pokud je server za NAT.
  use_external_ip: true

# Rychlé hlášení, kdo mluví, aby overlay reagoval okamžitě.
audio:
  active_level: 35
  min_percentile: 40
  update_interval: 400
  smooth_intervals: 2

room:
  empty_timeout: 120
  max_participants: 60

keys:
  VLOŽ_KLÍČ: VLOŽ_TAJEMSTVÍ

logging:
  level: info
  pion_level: error
```

Služba:

```bash
sudo nano /etc/systemd/system/livekit.service
```

```ini
[Unit]
Description=LiveKit SFU
After=network-online.target
Wants=network-online.target

[Service]
User=wardogs
ExecStart=/usr/local/bin/livekit-server --config /etc/livekit/livekit.yaml
Restart=on-failure
RestartSec=5
# Otevírá stovku UDP soketů najednou.
LimitNOFILE=65535

[Install]
WantedBy=multi-user.target
```

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now livekit
sudo systemctl status livekit --no-pager
```

---

## 4. Kód

```bash
sudo mkdir -p /opt/wardogs-comms
sudo chown wardogs:wardogs /opt/wardogs-comms
sudo -u wardogs git clone https://github.com/PMizenko/wardogs-comms.git /opt/wardogs-comms
cd /opt/wardogs-comms
sudo -u wardogs npm ci
sudo -u wardogs npm run build:shared
sudo -u wardogs npm run build -w @wardogs/server
```

`npm ci` nainstaluje i vývojové závislosti — TypeScript je potřeba k sestavení.
Po buildu je můžeš nechat být, nevadí.

---

## 5. Konfigurace serveru

```bash
sudo -u wardogs nano /opt/wardogs-comms/.env
```

```ini
PORT=4000
PUBLIC_URL=https://voip.alesza.eu

# MUSÍ být vypnuté. Jinak se kdokoli přihlásí jako kdokoli.
ALLOW_DEV_LOGIN=false

DISCORD_CLIENT_ID=<z Discord Developer Portalu>
DISCORD_CLIENT_SECRET=<z Discord Developer Portalu>
# Volitelné: jen členové tohoto Discord serveru se přihlásí
DISCORD_REQUIRED_GUILD_ID=

# openssl rand -hex 32
JWT_SECRET=<dlouhý náhodný řetězec>

LIVEKIT_URL=wss://sfu.alesza.eu
LIVEKIT_API_KEY=<klíč z kroku 3>
LIVEKIT_API_SECRET=<tajemství z kroku 3>
```

```bash
sudo chmod 600 /opt/wardogs-comms/.env
sudo chown wardogs:wardogs /opt/wardogs-comms/.env
```

Soubor obsahuje tajemství, kterými se podepisují přihlášení — proto `600`.

### Discord OAuth

V [Discord Developer Portalu](https://discord.com/developers/applications) →
tvoje aplikace → **OAuth2** → Redirects přidej **přesně** tohle:

```
https://voip.alesza.eu/auth/discord/callback
```

Musí se shodovat na znak, včetně `https` a cesty. Nesedící redirect URI je
nejčastější důvod, proč přihlášení skončí chybou.

---

## 6. Služba řídicího serveru

```bash
sudo nano /etc/systemd/system/wardogs-server.service
```

```ini
[Unit]
Description=Wardogs VOIP control server
After=network-online.target livekit.service
Wants=network-online.target

[Service]
Type=simple
User=wardogs
WorkingDirectory=/opt/wardogs-comms
Environment=NODE_ENV=production
ExecStart=/usr/bin/node packages/server/dist/index.js
Restart=on-failure
RestartSec=5

# Server nepotřebuje sahat nikam jinam než do svého adresáře.
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=strict
ProtectHome=true
ReadWritePaths=/opt/wardogs-comms

[Install]
WantedBy=multi-user.target
```

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now wardogs-server
sudo systemctl status wardogs-server --no-pager
curl -s http://127.0.0.1:4000/health
```

`WorkingDirectory` je důležité — server hledá `.env` vedle sebe.

---

## 7. nginx + certifikát

```bash
sudo nano /etc/nginx/sites-available/wardogs
```

```nginx
# Řídicí server: HTTP API + WebSocket na /ws
server {
    listen 80;
    server_name voip.alesza.eu;

    location / {
        proxy_pass http://127.0.0.1:4000;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;

        # Řídicí socket je dlouhoběžící; výchozí minuta by ho trhala.
        proxy_read_timeout 3600s;
        proxy_send_timeout 3600s;
    }
}

# LiveKit: jen signalizace. Zvuk jde mimo nginx přímo na UDP porty.
server {
    listen 80;
    server_name sfu.alesza.eu;

    location / {
        proxy_pass http://127.0.0.1:7880;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_read_timeout 3600s;
        proxy_send_timeout 3600s;
    }
}
```

```bash
sudo ln -s /etc/nginx/sites-available/wardogs /etc/nginx/sites-enabled/
sudo rm -f /etc/nginx/sites-enabled/default
sudo nginx -t
sudo systemctl reload nginx
```

Certifikát (obě domény musí být v Cloudflare **šedé**, jinak výzva neprojde):

```bash
sudo certbot --nginx -d voip.alesza.eu -d sfu.alesza.eu
```

Certbot si sám dopíše `listen 443 ssl` a přesměrování z HTTP. Obnova běží
automaticky; ověřit jde přes `sudo certbot renew --dry-run`.

---

## 8. Kontrola

```bash
curl -s https://voip.alesza.eu/health
curl -s https://voip.alesza.eu/config
```

`/config` musí vrátit `"discord":true` a `"devLogin":false`. Když vidíš
`"discord":false`, chybí Discord údaje v `.env`.

Ze svého počítače, z naklonovaného repozitáře:

```bash
LIVEKIT_URL=wss://sfu.alesza.eu \
LIVEKIT_API_KEY=<klíč> \
LIVEKIT_API_SECRET=<tajemství> \
npm run check:livekit
```

Nakonec nainstaluj desktopovou aplikaci a přihlas se. První zápas si odbyj ve
dvou lidech, ať víš, že zvuk teče, než na to pustíš celý platoon.

---

## Aktualizace serveru

```bash
cd /opt/wardogs-comms
sudo -u wardogs git pull
sudo -u wardogs npm ci
sudo -u wardogs npm run build:shared
sudo -u wardogs npm run build -w @wardogs/server
sudo systemctl restart wardogs-server
```

Restart shodí běžící platoony — drží se v paměti. Dělej to mezi zápasy.

Desktopová aplikace se aktualizuje sama z GitHub Releases, se serverem to
nesouvisí.

---

## Když něco nejde

```bash
sudo journalctl -u wardogs-server -f
sudo journalctl -u livekit -f
sudo tail -f /var/log/nginx/error.log
```

| Příznak | Skoro vždy to je |
| --- | --- |
| Aplikace hlásí, že server neodpovídá | `wardogs-server` neběží, nebo Cloudflare 525 — origin nemá platné TLS |
| Přihlášení skončí chybou | Nesedící redirect URI v Discordu |
| Roster naskočí, ale nikdo se neslyší | `sfu` je za Cloudflare proxy, nebo je zavřený UDP rozsah |
| Slyší se jen někdo | UDP blokuje síť toho hráče — ověř, že je otevřený `7881/tcp` jako záloha |
| Spojení se každou minutu trhá | Chybí `proxy_read_timeout` na `/` |
