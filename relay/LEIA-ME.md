# Servidor de salas (opcional)

As **salas** deixam várias pessoas assistirem o mesmo vídeo ao mesmo tempo (quem põe, pausa, pula, muda a velocidade ou troca de vídeo, muda para todos) e conversarem por voz. Ninguém transmite tela nem vídeo: **cada pessoa toca o seu próprio vídeo do YouTube** e o programa só mantém todo mundo no mesmo ponto. A **voz** vai direto de um computador para o outro (WebRTC); este servidor só leva as mensagens para eles se encontrarem.

O servidor é um **Cloudflare Worker com um Durable Object por sala**, no plano grátis. As pessoas ficam com uma conexão WebSocket aberta com a sala, então tudo chega na hora (sem ficar perguntando a cada segundo) e quem sai ou fecha o programa some da lista no mesmo instante. Enquanto nenhum servidor estiver configurado, o botão de sala não aparece no programa.

> **Quem só usa o programa não precisa fazer nada daqui:** o programa pronto (baixado em *Releases*) já vem ligado ao servidor do projeto original, configurado em [`web/config.js`](../web/config.js). Este guia é para quem faz um fork ou quer ter o próprio servidor.

## O que o servidor guarda e leva

Por sala: o código, o vídeo (ID do YouTube), a posição, se está tocando e a velocidade, mais, para cada pessoa conectada, um identificador aleatório (gerado na hora, não fica guardado no computador) e o **nome que a pessoa escolheu** para a sala. As mensagens da voz (SDP e candidatos ICE, que contêm endereços de rede) só **passam** de uma pessoa para a outra, não ficam guardadas. Salas sem uso por 24 horas são apagadas. Como em qualquer servidor, o Cloudflare enxerga o endereço IP de quem se conecta.

## Montar no Cloudflare (uns 15 minutos)

O Cloudflare só publica Durable Objects por **Git** (o painel não deixa colar o código, como dava com o modelo antigo). A boa notícia: depois de ligado, atualizar o servidor é só um `git push`.

1. Crie uma conta grátis em <https://dash.cloudflare.com/sign-up> (se já tem, entre). Não pede cartão.
2. Faça um **fork** deste repositório no GitHub (ou use o seu). O que importa é a pasta [`relay/`](.): ela tem o código ([`worker.js`](worker.js)) e a configuração ([`wrangler.jsonc`](wrangler.jsonc)).
3. No Cloudflare: **Workers & Pages** → **Create** → **Start with Hello World!**, com o nome **`lm-salas`** (é o `name` do `wrangler.jsonc`: os dois têm de ser iguais) → **Deploy**.
4. Nesse Worker: **Settings** → **Builds** → **GitHub**. O GitHub abre a tela de instalação do app *Cloudflare Workers and Pages*: escolha **Only select repositories**, marque só o seu fork e **Install & Authorize**. (Atenção: o app pede leitura e escrita em código, administração, checks, deployments e pull requests *do repositório escolhido*; é como todo app de CI.)
5. De volta ao Cloudflare, na tela *Connect to a repository*: repositório = o seu fork, ramo `main`, **Deploy command** = `npx wrangler deploy`, desmarque **Enable Preview builds**, em *Advanced settings* ponha **Path** = `relay` → **Connect**. O Cloudflare cria sozinho um token só para essas construções.
6. Envie qualquer commit para o `main` (ou, em *Deployments/Builds*, tente de novo): o Cloudflare constrói e implanta. O `wrangler.jsonc` cria a classe `Room` do Durable Object na primeira vez.
7. Confira abrindo no navegador `https://lm-salas.SEU-USUARIO.workers.dev/api/room/ABCDEFGH`: deve aparecer `{"now":…,"error":"room_not_found"}` (a sala não existe, e está tudo certo).
8. Em [`web/config.js`](../web/config.js), ponha o endereço (`relay: 'https://lm-salas.SEU-USUARIO.workers.dev'`) e compile de novo (`build.ps1`) ou publique uma versão nova. O botão **Sala** passa a aparecer.

Dica para depois: em *Settings → Builds → Build watch paths*, troque `*` por `relay/*` para só reconstruir quando algo do servidor mudar (cada implantação derruba por um instante as conexões abertas; os programas reconectam sozinhos).

### Limites do plano grátis

Durable Objects (versão SQLite) no plano grátis: **100 mil pedidos por dia** (cada conexão nova conta 1; as mensagens que chegam ao servidor contam na proporção de 20 para 1; as que saem não contam), **13 mil GB-s por dia** de tempo (sala parada, só com a conexão aberta, não conta) e 5 GB de armazenamento. O limite de pedidos é da **conta toda**. Uma sessão de sala gasta algumas dezenas de pedidos por pessoa-hora, então um grupo de amigos fica muito longe do limite. Se um dia ele acabar, o programa mostra "Reconectando…" e volta quando o dia virar (meia-noite UTC).

## Como as pessoas usam

- **Criar:** botão **Sala** → seu nome → **Criar sala**. O programa mostra um código de 8 letras e números (sem 0, 1, I e O, que se confundem). Passe o código para os amigos.
- **Entrar:** botão **Sala** → seu nome e o código → **Entrar**.
- Dentro da sala, pausar, tocar, pular, mudar a velocidade ou colar outro link vale para todos. A sala comporta até **8 pessoas**.
- **Sair da sala** volta ao normal, e a velocidade preferida de cada um é restaurada.

## Como funciona (resumo)

O estado da sala leva a **hora do servidor**; cada programa calcula a diferença entre o relógio do servidor e o do computador (pelas respostas ao `ping`) e põe o vídeo na posição certa mesmo com relógio adiantado ou atrasado. Se o vídeo de alguém ficar mais de 1,5 s fora do lugar, ele é trazido de volta sem avisar a sala (para não gerar eco).

Conexão: `wss://…/ws/<CODIGO>?id=<id>&name=<nome>[&create=1]`. O servidor manda `hello`, `join`, `leave`, `member`, `state`, `sig`, `pong` e `err`; a pessoa manda `set`, `name`, `voice`, `sig` e `ping`. Códigos de fechamento: 4400 pedido ruim, 4404 sala não existe, 4409 sala já existe, 4413 sala cheia, 4429 mensagens demais, 4000 trocada por outra conexão da mesma pessoa. O detalhe está no cabeçalho de [`worker.js`](worker.js). Programas antigos (1.3.x) continuam funcionando: o mesmo objeto responde pelas rotas HTTP `GET/POST /api/room/<CODIGO>`.

## Testar sem Cloudflare

Os testes ficam em [`../tests`](../tests) e só precisam de Python 3 (biblioteca padrão) e de um navegador. Com `python -m http.server 8000` na pasta do projeto, abra <http://localhost:8000/tests/room-test.html>: a página roda o código **real** do Worker e do Durable Object com um ambiente de mentira (sem rede) e mostra **OK 64/64** (rotas, proteção contra outro site, entrar e sair, estado, nomes, voz, sinalização, sala cheia, limite de mensagens, "dormir e acordar", alarme de 24 h e o modo HTTP dos programas antigos).
