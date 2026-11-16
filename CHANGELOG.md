# Histórico de versões

## v1.7.1 - 2026-11-16

- **A atualização automática não falha mais por acaso.** Uns 5 segundos depois de abrir, o programa limpa a pasta de espera das atualizações. Quando isso caía no meio do download da versão nova, a limpeza apagava o arquivo baixado (ou a pasta de trabalho) e a atualização falhava sem aviso, até a próxima vez que o programa abrisse (ou por mais 6 horas). Agora a limpeza e a atualização trabalham uma de cada vez, e a limpeza só apaga o que ninguém mexe há mais de 10 minutos (para não atrapalhar outra janela do programa aberta). Se o arquivo baixado sumir ou ficar preso mesmo assim (um antivírus, por exemplo), o programa tenta de novo 20 segundos depois. Provei com a limpeza rodando sem parar durante a atualização: a 1.7.0 falhou em todas as tentativas e esta versão baixa, avisa e instala todas as vezes.
- Quem está na 1.7.0 ou antes ainda atualiza com o código antigo: a troca para a 1.7.1 pode falhar uma vez, raramente, e então tenta de novo na próxima vez que o programa abrir. A partir da 1.7.1 as atualizações já usam o conserto.

## v1.7.0 - 2026-11-16

- **Menu suspenso (≡) na barra.** O botão **≡**, o primeiro da barra de cima, abre um menu com a **transparência**, o **volume do vídeo**, pesquisar ou colar link, sala e fila (com o número de vídeos), microfone, fone, voltar à velocidade 1× e sempre por cima. Em janelas pequenas a barra mostra só os botões que cabem (ficam sempre o ≡, a área de arrastar, minimizar e fechar) e **tudo o que sai da barra continua no menu**. O menu cabe até na janela mínima (rola se for baixa) e também existe na barra do modo navegação (pesquisa e Spotify), onde o site sai da frente enquanto ele está aberto. A barra agora se mede sozinha (`fitBar`), em vez de esconder botões em larguras fixas: nenhum botão fica cortado de 240 a 720 px, e os botões saem na ordem certa.
- **Transparência por uma barra, de 10 a 100%** (antes eram 5 passos, de 100% a 40%). Enquanto você arrasta, a janela mostra o resultado na hora.
- **Modo fantasma.** Com 50% ou menos, a janela some quase por completo e fica só uma **alça pequena (≡) no canto de cima**, para você nunca perdê-la e ela não ficar aparecendo toda hora: passar o mouse sobre a janela **não** a revela, só a alça revela (e clicar nela abre o menu). Revelada, ela fica inteira enquanto o mouse estiver nela e volta a ser fantasma quando o mouse sai ou fica parado por uns 3 s. Qualquer tela do programa por cima do vídeo (menu, sala, pesquisa, Spotify, erro, janela vazia, tela cheia) aparece inteira: a janela só fica transparente enquanto você assiste. Um menu esquecido aberto, com o mouse longe, se fecha sozinho.
- **Botões na miniatura da barra de tarefas**, como o Spotify: **anterior**, **play/pause**, **próximo**, **microfone**, **fone** e **volume − / +**. Anterior depois de 3 s volta ao começo do vídeo e, no começo, ao vídeo de antes (histórico); próximo toca o próximo da fila (na sala, para todos) ou da playlist. O microfone entra na voz, silencia e liga (verde = ligado, vermelho = mudo). O **fone** é novo: para de ouvir as pessoas da sala sem mexer no microfone nem no volume do vídeo (também no painel da sala e no menu). O volume vai de 5 em 5%. Os botões ficam cinza quando não servem (fora da sala, sem próximo) e os ícones acompanham o tema claro ou escuro do Windows.
- **Volume do vídeo no menu.** O controle de volume do próprio YouTube (o ícone de som e a barrinha no canto de cima, que não funcionava bem numa janela pequena) fica escondido; o volume agora é ajustado no menu ≡ (barra, botão de som e rodinha do mouse), no painel da sala e nos botões da miniatura. A tecla **M** do YouTube (mudo) continua valendo, e o menu acompanha. Com o controle dele fora do canto, a barra do programa ganhou 48 px de largura.
- O botão de transparência antigo (que alternava entre 5 níveis) foi substituído pela barra do menu.
- **Tela inicial arrumada.** Com o botão **Sala e fila** (que chegou nas versões 1.3 a 1.5), os atalhos da tela inicial passavam para uma segunda linha e, no tamanho padrão (480 × 270), o conteúdo passava da janela e aparecia uma barra de rolagem. Agora os quatro atalhos ficam numa linha só (o botão "Explorar YouTube" virou "YouTube") e o conteúdo cabe sem rolar, do tamanho padrão para cima.

## v1.6.0 - 2026-11-16

- **Fila de vídeos só sua, fora das salas.** A aba **Fila** agora existe também quando você não está numa sala: o painel do botão **Sala e fila** (o ícone de pessoas da barra, que mostra o número de vídeos na fila) tem as abas **Sala** e **Fila**. Fora da sala a fila é **sua**, só neste computador, e fica guardada mesmo se você fechar o programa; dentro de uma sala é a fila da sala (a de todos), e quando você sai a sua volta como estava. O resto é igual: cole um link (ou use o **+** dos resultados da pesquisa), **arraste pelo cabo ⋮⋮** para mudar a ordem (ou ↑ ↓), **▶** toca na hora, **✕** tira, e **quando o vídeo acaba toca o próximo**. Com nada tocando, o primeiro vídeo adicionado já começa a tocar. Um vídeo da sua fila que não pode tocar aqui (bloqueado pelo dono, removido) é pulado.
- O **+** dos resultados agora funciona em qualquer lugar (antes só dentro de uma sala) e, se um vídeo da fila começa a tocar enquanto você ainda está olhando os resultados, ele toca por trás sem tirar você da pesquisa.
- O painel da sala ganhou as abas **Sala | Fila** no topo, em vez do título "Sala".

## v1.5.1 - 2026-11-16

- **A pesquisa do YouTube ficou mais resistente.** Se o YouTube devolver uma página incompleta, der um erro passageiro ou a rede falhar na hora, o programa tenta de novo sozinho (uma vez, depois de 0,7 s); lê a lista de resultados mesmo quando a página vem com outro desenho (o YouTube testa variantes) e mesmo quando o texto da página tem chaves e aspas no meio; e, se ainda assim não der, a mensagem de erro traz uma pista curta (tamanho e título da página recebida) para facilitar a correção.
- Dentro da sala, abrir a aba **Fila** já aquece a janela que acha o título dos links colados, então o primeiro link colado não fica sem título.

## v1.5.0 - 2026-11-16

- **Fila de vídeos compartilhada na sala.** No painel da sala, a aba **Fila** guarda os vídeos que vêm a seguir (até 50), e a lista é a mesma para todo mundo. Qualquer pessoa adiciona colando um link ou com o **+** dos resultados da pesquisa (aparece o aviso "Ana adicionou à fila: …"). **Arraste pelo cabo ⋮⋮ com o mouse** para mudar a ordem (ou use ↑ ↓ no teclado), toque um item na hora com o **▶** ou tire da fila com o **✕**. **Quando o vídeo acaba, a sala passa sozinha para o próximo da fila**, para todos (se vários computadores avisam o fim ao mesmo tempo, só o primeiro conta). Com a sala parada (sem vídeo, ou o último acabou e não havia próximo), o que for adicionado já começa a tocar. Ctrl+V com a aba aberta também põe o link na fila.
- **Pesquisa do YouTube com lista de resultados, como no YouTube.** Ao pesquisar (Ctrl+L, digitar, Enter) aparece uma lista no próprio programa, com miniatura, duração, título, canal, visualizações e data; rolar até o fim carrega mais resultados; clicar no vídeo toca no player e o **+** põe na fila. A lista é feita para janelas pequenas e não traz os anúncios do site. O **site do YouTube** continua disponível ("Ver no site do YouTube", a casinha da barra e o botão Explorar YouTube).
- **Correção importante nas salas:** quem **pulava** o vídeo (arrastando a barra) ou **mudava a velocidade** saía de sincronia. A correção de atraso puxava o vídeo dessa pessoa de volta para a posição de antes enquanto a sala e todos os outros já estavam na nova. Agora o que você faz passa a valer na hora também para a sua própria janela.
- O servidor das salas (Cloudflare) já está atualizado com a fila; programas 1.3.x e 1.4.x continuam entrando nas salas, só sem a fila.

## v1.4.1 - 2026-11-16

- **A pesquisa do YouTube e o Spotify voltam a aparecer.** Nas versões 1.2.0 a 1.4.0 a janela dos sites (resultados do YouTube, Spotify) abria por baixo da janela principal do programa, que é opaca: o que aparecia era só o fundo escuro com "Abrindo…", como se nada carregasse. Agora a janela do site sempre fica por cima, e só a barra de cima e as bordas de redimensionar continuam sendo do programa.

## v1.4.0 - 2026-11-12

- **Conversa por voz nas salas.** Dentro de uma sala, o botão de **microfone** (na barra de cima e no painel da sala) liga a voz, como num Discord: todo mundo ouve todo mundo enquanto assiste junto. O áudio vai **direto entre os computadores** (WebRTC), sem passar pelo servidor. Tem **dois volumes separados**, o do vídeo e o das vozes, **volume e silenciar por pessoa** (só para você), o silenciar do seu próprio microfone, um contorno verde em quem está falando e o ícone vermelho em quem está mudo. Dá para entrar na voz só para ouvir, sem microfone. **Use fones de ouvido** para não gerar eco. Até 8 pessoas por sala. Em redes muito restritas (algumas de empresas e faculdades) a voz pode não conectar; o vídeo continua sincronizado.
- **Sincronia em tempo real.** O servidor das salas agora mantém uma conexão aberta com cada pessoa (WebSocket com Durable Objects, no Cloudflare), em vez de ser consultado a cada segundo. Pausa, play, pulo, velocidade e troca de vídeo chegam aos outros em menos de meio segundo (antes passava de 1 segundo), e o relógio de cada computador é medido de novo de tempos em tempos para manter o ponto do vídeo certo.
- **Quem sai da sala some na hora.** Sair, fechar a janela ou encerrar o programa tira a pessoa da lista em menos de meio segundo (antes ela continuava aparecendo por até 30 segundos). Se a internet cair de repente, a pessoa tem 5 segundos para voltar sem que ninguém perceba; passado isso, sai da lista e volta a entrar sozinha quando a conexão voltar.
- **Nomes na sala.** Você escolhe um nome (fica lembrado), o painel mostra quem está na sala e aparecem avisos de "X entrou na sala" e "X saiu da sala".
- A barra de cima ganhou o botão do microfone e continua sem cortar nenhum botão em qualquer largura de janela (de 240 a 700 px e mais).
- Salas e programas da 1.3.x continuam funcionando com o servidor novo, só sem o tempo real e a voz. **Quem monta o próprio servidor:** ele agora é um Worker com Durable Object e não usa mais o D1; o passo a passo atualizado está em `relay/LEIA-ME.md`.
- Privacidade: o microfone só é ligado quando você clica no botão, e só o próprio programa pode usá-lo (o YouTube e outros sites dentro dele, não). Quem está na voz enxerga o endereço IP das outras pessoas na voz, como em qualquer chamada direta pela internet.

## v1.3.1 - 2026-11-12

- **Salas no ar.** O servidor de salas (Cloudflare, plano grátis) já está funcionando e o botão **Sala** (ícone de pessoas) aparece na barra de cima e na tela inicial. **Criar sala** mostra um código de 8 letras e números; quem tem o código usa **Entrar**. Quem põe, pausa, pula, muda a velocidade ou troca de vídeo, muda para todos, e cada pessoa toca o seu próprio vídeo (não é transmissão de tela). Pequenos atrasos são corrigidos sozinhos, mesmo com o relógio do computador adiantado ou atrasado. Esta versão chega sozinha a quem já tem a 1.3.0.
- Correção nas salas: uma pausa, um play ou uma mudança de velocidade feita logo depois de a sala mudar (menos de 2 segundos) era ignorada e não chegava aos outros. Agora só o que a própria sala causou no vídeo é ignorado.

## v1.3.0 - 2026-11-12

- **Atualização automática.** Ao abrir, o programa confere no GitHub se há uma versão nova. Se houver, baixa o arquivo, confere o SHA-256 que o próprio GitHub informa e mostra um aviso verde **"Nova versão X · Atualizar"** junto com a barra de cima. Um clique troca os arquivos, abre a versão nova e volta ao mesmo vídeo e minuto. Se você não clicar, a atualização é instalada sozinha na próxima vez que abrir o programa. Se a versão nova não abrir, tudo volta ao que era. Pasta sem permissão de escrita: o aviso vira **"Baixar"** e abre a página da versão. Para desligar, ponha `update=0` no `config.ini`. **Quem está na 1.2.0 ou antes precisa baixar esta versão uma vez; daí em diante é automático.**
- **Salas para assistir junto (em preparação).** O código das salas já está no programa: com um código de 8 letras, todo mundo vê o mesmo vídeo ao mesmo tempo (quem põe, pausa, pula, muda a velocidade ou troca de vídeo, muda para todos; cada pessoa toca o seu próprio vídeo). O botão **Sala** só aparece quando há um servidor de salas configurado, e a versão pública ainda não tem um. O passo a passo para montar o servidor (grátis, no Cloudflare) está em `relay/LEIA-ME.md`.
- O painel da sala se adapta a janelas bem pequenas (sem barra de rolagem feia).
- Opção `--minimized` na linha de comando: abre o programa minimizado.

## v1.2.0 - 2026-11-12

- **Pesquisa do YouTube dentro do programa.** A tela de pesquisa (**Ctrl+L** ou o botão da lupa) aceita texto: digite o que procura e os resultados do YouTube aparecem numa janela por baixo da barra do programa. Ao clicar num vídeo, ele toca no seu player (com a velocidade livre e os atalhos), e a pesquisa fica guardada para você voltar a ela. Link colado no campo continua tocando direto. O botão do campo muda sozinho entre "Reproduzir" e "Buscar".
- **Spotify como módulo extra.** Um botão na tela de pesquisa (e uma aba na barra do modo navegação) abre o player web do Spotify dentro do programa. Entre na sua conta uma vez e as suas playlists e músicas curtidas aparecem; o Spotify continua tocando quando você volta ao player.
- Nova barra do modo navegação (voltar ao player, abas YouTube/Spotify, campo de pesquisa, página inicial, fixar, minimizar, fechar) que se adapta a qualquer largura de janela. A janela do site acompanha o redimensionamento e as bordas continuam livres para redimensionar.
- A tela inicial ganhou os atalhos "Colar link", "Explorar YouTube" e "Spotify".

## v1.1.0 - 2026-11-12

- **A barra do programa não cobre mais os botões do YouTube.** Antes ela ocupava a largura toda e tapava o mudo, as **legendas (CC)** e a engrenagem, que ficam no canto superior direito. Agora é uma pílula no canto esquerdo (que se encolhe nas janelas pequenas) e deixa esse canto livre. Ela inteira arrasta a janela, menos os botões.
- **Velocidade livre pelo teclado**, como no *Video Speed Controller*: **D** acelera e **S** desacelera (0,1× por toque; com **Shift**, 1×), **R** volta a 1× (de novo, volta à velocidade anterior). Vai de **0,07× até 16×** (o player do YouTube só chega a 2×). A velocidade fica lembrada para o próximo vídeo e para a próxima vez que abrir o programa. Um selo na barra e um aviso no meio do vídeo mostram o valor.
- **Z** e **X** voltam e avançam 10 segundos.
- O foco volta para o vídeo depois de clicar num botão da barra, para as teclas (e as do próprio YouTube, como **C** para legendas) continuarem valendo.

## v1.0.0 - 2026-11-12

- Primeira versão: mini player de YouTube por cima de tudo, com link colado por Ctrl+V, janela sem borda que se move e redimensiona por qualquer lado, interface responsiva, transparência, "sempre por cima", tela cheia e posição lembrada.
