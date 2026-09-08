# Scanner — Prospecção de canais do YouTube

Ferramenta pessoal para buscar canais do YouTube por nicho, faixa de inscritos
e país, extrair contatos públicos (e-mail, Twitter/X, Discord, Instagram) e
organizar tudo em um mini-CRM de prospecção. Roda 100% no navegador, sem
backend — usa sua própria chave da YouTube Data API v3 (modelo *bring your
own key*).

## Como rodar

Não precisa de build nem instalação. Duas opções:

**Opção 1 — abrir direto**
Dê duplo clique em `index.html`.

**Opção 2 — servidor local (recomendado)**
Alguns navegadores restringem `fetch` em arquivos abertos via `file://`.
Se os resultados não carregarem, sirva a pasta localmente:

```bash
# Python
python3 -m http.server 8080

# ou Node
npx serve .
```

Depois acesse `http://localhost:8080`.

## Como conseguir sua chave da API (grátis, ~2 min)

1. Acesse [console.cloud.google.com](https://console.cloud.google.com)
2. Crie um projeto (ou use um existente)
3. Vá em **APIs e Serviços → Biblioteca**, procure **"YouTube Data API v3"** e ative
4. Vá em **APIs e Serviços → Credenciais → Criar credenciais → Chave de API**
5. Copie a chave (começa com `AIza...`)
6. Cole na aba **Chaves API** do Scanner

Cada chave tem cota de **10.000 unidades/dia**. Você pode adicionar quantas
chaves quiser (uma por projeto no Google Cloud) — o Scanner alterna entre
elas automaticamente quando uma esgota.

## Custo aproximado de cota

| Ação | Custo |
|---|---|
| Buscar canais por nicho (`search.list`) | 100 unidades / página (até 50 resultados) |
| Detalhes do canal — inscritos, país, descrição (`channels.list`) | 1 unidade / lote de até 50 |
| Checar atividade recente (`activities.list`, só se o filtro estiver ativo) | 1 unidade / canal candidato |

A busca para automaticamente depois de 6 páginas (limite de segurança para não
estourar sua cota diária sem querer), mesmo que a quantidade desejada não
tenha sido atingida — por isso buscas muito filtradas às vezes gastam a mesma
cota independente de quantos canais realmente sobrevivem aos filtros.

Buscas mais amplas (nicho genérico, sem filtro de país) gastam menos cota por
resultado útil. Buscas muito específicas (nicho + faixa estreita de inscritos
+ país) gastam mais porque descartam mais canais depois de já ter pago pela
busca.

## Estrutura do projeto

```
scanner/
├── index.html      # estrutura da página
├── style.css        # visual (tema escuro, verde-sinal)
├── script.js         # lógica: busca na API, extração de contatos, CRM
├── .gitignore
└── README.md
```

## Onde os dados ficam salvos

Chaves de API e leads importados ficam salvos no **localStorage** do seu
navegador — não são enviados para nenhum servidor além das chamadas diretas
à API do Google. Isso também significa que os dados são por navegador/
dispositivo; não sincronizam entre máquinas.

## Funcionalidades

- Busca por até 3 nichos, país e faixa de inscritos
- Extração automática de e-mail, Twitter/X, Discord e Instagram públicos na
  descrição do canal
- Filtro "só com e-mail público"
- Filtro "postou recentemente" (30/60/90/180 dias) — descarta canais inativos
- Mini-CRM com status (não contatado, contatado, respondeu, parceria,
  recusou), anotações por lead e filtros
- Exportação de leads em CSV

## Limitações conhecidas

- O campo de "e-mail público" do YouTube não é mais exposto diretamente pela
  API oficial; o Scanner extrai qualquer e-mail que o criador tenha colocado
  no texto da descrição do canal — nem todo canal terá um.
- Filtro de país depende do campo `country` que o próprio canal preencheu nas
  configurações; canais sem esse campo preenchido não aparecerão em buscas
  filtradas por país.
- A API do YouTube não garante relevância perfeita para termos de nicho —
  ela casa com o texto de título/descrição/tags dos canais, então às vezes
  aparecem resultados fora do esperado.