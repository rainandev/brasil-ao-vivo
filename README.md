# BRASIL // AO VIVO

Apuração da eleição presidencial de 2026 dentro do próprio site: percentuais e votos de cada candidato, seções totalizadas, brancos, nulos, abstenção, **mapa 3D interativo** das 27 UFs (com versão 2D acessível) e consulta por estado. A página se atualiza sozinha. O TSE é usado só como fonte de dados, nos bastidores. **O site não simula dados:** tudo o que aparece vem dos arquivos oficiais do TSE.

## Fonte oficial

Os dados vêm dos arquivos de **resultado unificado** (`-u.json`, especificação EA20) que o TSE publica na divulgação oficial (`resultados.tse.jus.br`):

```
https://resultados.tse.jus.br/oficial/ele2026/{eleicao}/dados/{uf}/{uf}-c0001-e{eleicao com 6 dígitos}-u.json
```

| Código | Eleição | Data |
| --- | --- | --- |
| 6258 | Eleição Ordinária Federal 2026, 2º turno (padrão) | 25/10/2026 |
| 6257 | Eleição Ordinária Federal 2026, 1º turno | 04/10/2026 |

Os códigos estão em `https://resultados.tse.jus.br/oficial/comum/config/ele-c.json`. Em 2026 o TSE deixou de publicar a pasta `dados-simplificados` usada em 2022.

Cada ciclo de consulta lê 29 arquivos: `br`, as 27 UFs e `zz` (Exterior). As fotos vêm de `.../ele2026/{eleicao}/fotos/br/{sqcand}.jpeg`. Se uma foto falhar, o card mostra as iniciais.

### Campos usados

| Na tela | Campo do TSE |
| --- | --- |
| % do candidato (votos válidos) | `pvap`, exibido exatamente como publicado, sem recálculo |
| Votos do candidato | `vap` |
| Nome, partido, número, situação | `nmu`/`nm`, `par.sg`, `n`, `st` |
| Seções totalizadas | `s.st` de `s.ts`, com percentual `s.pst` |
| Votos válidos, brancos, nulos | `v.vv`, `v.vb`/`v.pvb`, `v.tvn`/`v.ptvn` |
| Abstenção | `e.a` / `e.pa` |
| Horário dos dados | `dg` + `hg` (horário de Brasília) |
| Parcial ou final | `and` (`f` = encerrada) e `s.st` (0 = não iniciada) |

### Resultado do 1º turno

O 1º turno está encerrado. O site tenta ler o arquivo oficial ao vivo (eleição 6257). Se o TSE não responder, usa `public/data/primeiro-turno-registro.js`, o **registro da totalização final** de 05/10/2026 (100% das seções). Esse registro tem os dois candidatos que foram ao 2º turno, em cada UF. Os valores foram transcritos dos arquivos oficiais e conferidos de duas formas: a soma das 27 UFs e do Exterior bate exatamente com o total do Brasil (FLAVIO BOLSONARO 56.104.503, LULA 53.879.538), e esse total confere com a página oficial do TSE. Um teste automatizado refaz essa soma. A leitura ao vivo sempre tem prioridade sobre o registro. O 2º turno nunca usa o registro.

No 2º turno, um quadro "1º turno · resultado final" fica no topo com os dois candidatos, as fotos, os percentuais e os votos.

### Fotos

As fotos de Lula e Flávio Bolsonaro ficam no próprio site (`public/img/candidatos/*.webp`, 320 px). São usadas só quando o número **e** o nome do candidato no arquivo oficial conferem (13/LULA e 22/FLÁVIO). Qualquer outro candidato usa a foto publicada pelo TSE. Se a imagem falhar, aparecem as iniciais.

As contas feitas pelo site servem só para **conferência**: a soma dos `vap` contra `v.vv` e o `vap/vv` contra o `pvap`. Se algo não bater, o painel mostra um aviso e continua exibindo o número oficial.

## Como funciona a atualização

```
navegador ──(a cada 30 s)──▶ /api/resultados ──(no máx. 1 vez a cada 20 s)──▶ TSE (29 arquivos)
                                  │
                         CDN da Vercel (s-maxage=20) + memória da função
```

1. **`api/resultados.js`** (função da Vercel) busca os 29 arquivos em paralelo, com limite de 6 s por arquivo. Depois valida a estrutura de cada um: UF, eleição, contagem de seções e votos inteiros. O resultado vira um JSON único.
2. **Cache:** a resposta sai com `Cache-Control: s-maxage=20, stale-while-revalidate=40`. Todos os visitantes recebem a mesma cópia da CDN. Visitas simultâneas na mesma instância compartilham uma única ida ao TSE. Com 10 visitantes ou com 100 mil, o TSE recebe no máximo cerca de 29 requisições a cada 20 s por região da CDN.
3. **Navegador:** consulta `/api/resultados` a cada **30 s** e não recarrega a página. A consulta pausa quando a aba fica oculta e retoma ao voltar. Depois de uma falha, as tentativas se espaçam (30 → 60 → 120 s). Quando todos os recortes estão finais, o intervalo passa a 5 min.
4. **Sem retrocesso:** uma leitura só substitui a anterior se o horário `dg/hg` do TSE avançou ou se há mais seções totalizadas. Isso vale no servidor e no navegador. Respostas fora de ordem, como as de uma troca de aba, são descartadas.
5. **Falhas:** se um arquivo falhar (HTTP, JSON inválido, tempo esgotado ou estrutura inesperada), o painel mantém a última leitura válida daquele recorte, marcada como desatualizada, e mostra um aviso. Se ainda não houver leitura válida, aparece "Aguardando divulgação dos resultados oficiais". Nenhum número é preenchido por estimativa.
6. **Plano B:** em produção, se a rota falhar, o navegador lê os mesmos arquivos direto do TSE, que permite CORS.

**Por que 30 s:** o TSE publica novas versões dos arquivos em intervalos da ordem de um minuto durante a apuração. Consultar mais rápido que isso não traz dados mais novos e gasta a cota gratuita da Vercel. A tela mostra separadamente o **horário dos dados do TSE** e o **horário da última consulta bem-sucedida**.

## Mapa 3D

O mapa usa a geometria real das 27 UFs (malha IBGE via `click_that_hood`), projetada e simplificada por `scripts/build-map.mjs` em `public/data/brasil-uf.json` (72 KB).

- **3D (padrão):** em `public/js/mapa3d.js`, cada estado é extrudado com Three.js 0.160 (hospedado em `public/vendor/three/`, sem depender de CDN). Na entrada, os estados sobem em onda a partir do centro do país. O estado selecionado se eleva e os demais escurecem. Um rótulo flutuante mostra quem lidera ali, e o mouse no desktop gera uma leve paralaxe. Quando um estado recebe dado novo, ele pulsa. O desenho só acontece enquanto há animação e pausa fora da tela ou com a aba oculta, o que economiza bateria. A câmera se ajusta sozinha a qualquer proporção de tela. A animação usa o relógio real, então termina no tempo certo mesmo em celulares lentos.
- **2D:** em SVG com profundidade, focável pelo teclado. É usado automaticamente sem WebGL ou com "reduzir movimento" ativado, e pode ser escolhido no botão 3D/2D (a escolha fica salva).

- **Cores:** vermelho para um dos dois mais votados no Brasil e platina para o outro. A atribuição segue a ordem do número de urna, então a cor não troca durante a apuração. A intensidade indica a diferença entre o 1º e o 2º colocados no estado (1–10, 10–20 e 20+ p.p.). Diferença menor que 1 p.p. aparece hachurada. Estados sem dados ficam em preto.
- **Acessibilidade:** cada estado pode ser focado com o teclado (Tab, depois Enter ou Espaço) e tem uma descrição em texto (`aria-label`). Há também um seletor de estado e uma tabela com todos os estados em texto.
- **Celular:** os candidatos aparecem primeiro e o mapa permite tocar no estado. Os alvos de toque têm pelo menos 40–44 px, as margens respeitam a área segura (notch) e não há rolagem lateral. Testado de 320 px (iPhone SE) a 430 px e com o celular deitado.

## Animações

- Entrada escalonada das seções.
- Seletor de turno deslizante.
- Contadores de votos e percentuais que **terminam sempre no texto oficial**.
- Anel de progresso ao redor da foto do candidato.
- Barras com brilho.
- Destaque do candidato que lidera.
- Pulso nos números atualizados.
- Barra de progresso das seções no topo.

Tudo respeita `prefers-reduced-motion`.

## Crédito no rodapé

O rodapé mostra a foto e o nome de Rainan (Web designer · Front-end). Para exibir o botão do Instagram, preencha o `@` em `public/index.html`, no atributo `data-instagram=""` do elemento `#credito`. Exemplo: `data-instagram="seu.usuario"`.

## Rodar localmente

```bash
npm install          # só ferramentas de desenvolvimento (geração do mapa)
npm run dev          # http://localhost:3000, usando o TSE real
```

## Testes

```bash
npm test             # 34 testes unitários (node:test, sem dependências)
npm run test:e2e     # 17 testes no navegador (Playwright + Chromium, mapa 3D via WebGL por software)
```

Para os testes de navegador: `npm i -D playwright && npx playwright install chromium`.

| Requisito | Onde |
| --- | --- |
| 1. Leitura da fonte oficial (URL, formato, 29 arquivos) | `tests/unit/core.test.mjs`, `tests/unit/fonte.test.mjs` |
| 2. Votos e percentuais (oficiais, sem recálculo) | `core.test.mjs` |
| 3. Atualização automática sem recarregar | `tests/e2e/ui.test.mjs` |
| 4. Resultados por estado (mapa, seletor, teclado) | `ui.test.mjs` |
| 5. Nenhum número sem dado oficial | `ui.test.mjs`, `fonte.test.mjs` |
| 6. Erros, indisponibilidade, dados incompletos, respostas antigas | `fonte.test.mjs`, `ui.test.mjs` |
| 7. Celular (320, 360, 390 e 430 px; toque no 2D e no 3D; alvos de toque; sem rolagem horizontal) | `ui.test.mjs` |
| Registro real do 1º turno (soma das UFs = Brasil; números exibidos) | `core.test.mjs`, `fonte.test.mjs`, `ui.test.mjs` |
| 8. Cache e frequência de consultas | `fonte.test.mjs`, `tests/unit/api-vercel.test.mjs` |
| 9. Compatibilidade com a Vercel | `api-vercel.test.mjs` |

**O site publicado não tem modo de dados simulados.** A base da fonte é fixa em `https://resultados.tse.jus.br` e nenhuma variável de ambiente a muda. Para verificar automaticamente situações que ainda não aconteceram (apuração andando, TSE fora do ar, arquivo quebrado), os testes injetam um `fetch` falso direto na função, apenas dentro de `tests/`. Esses arquivos de teste usam nomes fictícios ("CANDIDATA TESTE ALFA") e nunca são publicados. Um teste garante que nenhum arquivo de `public/`, `api/` ou `lib/` contém dados ou chaves de teste.

## Variáveis de ambiente

Nenhuma é obrigatória. Os padrões apontam para a fonte oficial. Veja `.env.example`.

| Variável | Padrão | Uso |
| --- | --- | --- |
| `TSE_ELEICAO_2T` | `6258` | código do 2º turno |
| `TSE_ELEICAO_1T` | `6257` | código do 1º turno |
| `TSE_CICLO` | `ele2026` | pasta do ciclo |
| `TSE_AMBIENTE` | `oficial` | ambiente de divulgação |
| `CACHE_SEGUNDOS` | `20` | cache compartilhado da rota |
| `TSE_TIMEOUT_MS` | `6000` | limite de espera por arquivo |

Não há segredos, chaves ou banco de dados. Os dados do TSE são públicos.

## Publicar na Vercel (plano gratuito)

1. Crie um repositório no GitHub e envie o projeto:
   ```bash
   git remote add origin https://github.com/SEU_USUARIO/brasil-ao-vivo.git
   git push -u origin main
   ```
2. Em vercel.com, clique em **Add New → Project** e importe o repositório.
3. Framework Preset: **Other**. Deixe Build Command e Install Command vazios. O `vercel.json` já define `outputDirectory: public` e a função `api/resultados.js` com limite de 15 s, abaixo do limite do plano Hobby.
4. Clique em **Deploy**. Cada `git push` na branch principal publica de novo.
5. Para conferir, abra `https://SEU-PROJETO.vercel.app/api/resultados?turno=1`. O campo `arquivosLidos` deve ser 28 ou 29.

**Consumo no plano Hobby:** com o cache de 20 s, a função roda no máximo cerca de 3 vezes por minuto por região, mesmo com muito tráfego. Isso fica bem abaixo dos limites gratuitos de invocações e de tempo de execução.

## Limitações conhecidas

- O ambiente em que este código foi escrito **não tinha acesso de rede a `resultados.tse.jus.br`**. O formato `-u.json` foi confirmado por um projeto público que lê esses arquivos em produção em 2026 (`gabrielandr/apuracao-2026`), mas o código ainda não leu um arquivo real do TSE. Depois do deploy, confira `/api/resultados?turno=1`: o 1º turno já está encerrado e deve vir completo.
- Se o TSE bloquear os IPs da Vercel, a rota responde com erro e o navegador passa a usar o plano B (leitura direta).
- A cor dos estados usa os dois candidatos mais votados no Brasil. No 1º turno, um estado liderado por um terceiro candidato aparece em âmbar ("Outro candidato lidera").
