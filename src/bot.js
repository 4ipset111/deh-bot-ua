const { Client, Collection, WebhookClient, ActionRowBuilder, ButtonBuilder, ButtonStyle, ChannelType, PermissionFlagsBits, ChannelSelectMenuBuilder, ModalBuilder, TextInputBuilder, TextInputStyle, RoleSelectMenuBuilder } = require('discord.js');
const { readdirSync, writeFileSync, readFileSync, mkdirSync, writeFile } = require('node:fs');
const { default: axios } = require('axios');
const logger = require('./modules/logger');
const { localize } = require('./modules/localization');
const { ownerId, developerIds, roleIds, colors, emojis, beta } = require('../config');
const { diffLines } = require('diff');
const EmbedMaker = require('./modules/embed');
const { execSync } = require('node:child_process');
const { QuickDB } = require('quick.db');
const timer = require('./modules/timer');
const Home = require('./modules/home');
const AutoMod = require('./modules/automod');

const client = new Client({
    intents: [
        'Guilds',
        'GuildMessages',
        'MessageContent',
        'GuildMessageReactions',
        'DirectMessages'
    ]
});
const webhooks = {
    extraStuff: new WebhookClient({
        url: process.env.EXTRA_STUFF_WEBHOOK
    }),
    otherChanges: new WebhookClient({
        url: process.env.OTHER_CHANGES_WEBHOOK
    })
};
const db = new QuickDB();

client.commands = new Collection();

const commandFiles = readdirSync('src/commands').filter(file => file.endsWith('.js'));

if (commandFiles.length > 0) logger('info', 'COMMAND', 'Found', commandFiles.length.toString(), 'commands');
else logger('warning', 'COMMAND', 'No commands found');

for (const file of commandFiles) {
    const command = require(`./commands/${file}`);

    client.commands.set(command.data.name, command);

    logger('success', 'COMMAND', 'Loaded command', command.data.name);
};

async function checkScript(script, i, webhook, pings) {
    logger('info', 'SCRIPT', 'Checking script', script);

    let oldScript = '';

    try {
        oldScript = readFileSync(`scripts/current${i}.js`, 'utf-8').toString();
    } catch (error) {
        try {
            writeFileSync(`scripts/current${i}.js`, '', 'utf-8');

            oldScript = readFileSync(`scripts/current${i}.js`, 'utf-8').toString();
        } catch (error) {
            try {
                mkdirSync('scripts');
                writeFileSync(`scripts/current${i}.js`, '', 'utf-8');

                oldScript = readFileSync(`scripts/current${i}.js`, 'utf-8').toString();
            } catch (error) {
                return logger('error', 'SCRIPT', 'Error while reading script', 'current.js', `\n${error}`);
            };
        };
    };

    let newScript = (await axios.get(`https://canary.discord.com/assets/${script}`)).data;

    writeFileSync(`scripts/current${i}.js`, newScript, 'utf-8');

    newScript = execSync(`beautifier ./scripts/current${i}.js`, {
        maxBuffer: Infinity
    }).toString();

    writeFileSync(`scripts/current${i}.js`, newScript, 'utf-8');

    if (oldScript === '') return logger('warning', 'SCRIPT', 'Old script empty, skipping', script);
    if (oldScript === newScript) return logger('warning', 'SCRIPT', 'Scripts are the same, skipping', script);

    logger('success', 'SCRIPT', 'Script fetched', script);

    let diff = diffLines(oldScript, newScript);
    let diffText = '';
    let writing = false;

    for (let line of diff) {
        if (line.added) {
            diffText += `${!writing ? '\n...\n' : '\n'}+ ${line.value.split('\n').filter(l => l !== '').join('\n+ ')}`;
            writing = true;
        } else if (line.removed) {
            diffText += `${!writing ? '\n...\n' : '\n'}- ${line.value.split('\n').filter(l => l !== '').join('\n- ')}`;
            writing = true;
        } else writing = false;
    };

    logger('success', 'SCRIPT', 'Generated diff for script', script);

    let response;

    try {
        response = (await axios.post('https://beta.purgpt.xyz/openai/chat/completions',
            {
                personality: 'programmer-ai',
                messages: [
                    {
                        role: 'user',
                        content: `You have to respond in a code block with diff format. Please show me the useful changes, not the entire script. Also please don't show license comments, changes related to build numbers and source mapping comments. If you don't see any useful changes, just say "skip" without a code block.\n\n\`\`\`diff\n${diffText.length > 15700 ? diffText.slice(0, 15700) + '...' : diffText}\n\`\`\``
                    }
                ]
            },
            {
                headers: {
                    'Content-Type': 'application/json',
                    Authorization: `Bearer ${process.env.PURGPT_API_KEY}`
                }
            }
        )).data;
    } catch (error) {
        logger('error', 'SCRIPT', 'Error while sending to AI', `\n${error}`);
    };

    let content = response?.choices?.[0]?.message?.content;

    if (content) {
        if (content === 'skip') return logger('warning', 'SCRIPT', 'AI skipped script', script);
        else {
            let codeBlockRegex = /```diff\n([\s\S]+?)\n```/g;
            let codeBlock = codeBlockRegex.exec(content);

            if (codeBlock) diffText = codeBlock[1];
        };
    };

    logger('success', 'SCRIPT', 'AI responded to script', script);

    const embed = new EmbedMaker(client)
        .setTitle('Code Changes')
        .setDescription(`\`\`\`diff\n${diffText.length > 4000 ? diffText.slice(0, 4000) + '...' : diffText}\`\`\``)
        .setFields(
            {
                name: 'Script',
                value: script,
                inline: true
            },
            {
                name: 'Updated At',
                value: `<t:${Math.floor(Date.now() / 1000)}:R>`,
                inline: true
            }
        );

    embed.data.footer.text = 'Powered by Discord-Datamining/Discord-Datamining & purgpt.xyz';

    webhooks[webhook].send({
        content: pings.map(id => `<@&${id}>`).join(' '),
        embeds: [embed]
    });

    logger('success', 'SCRIPT', 'Sent diff for script', script);
};

async function checkScripts() {
    let branch = (await axios.get('https://api.github.com/repos/Discord-Datamining/Discord-Datamining/commits/master')).data;
    let scripts = branch.commit.message.match(/[a-f0-9]*\.js/gm);

    if (scripts.length === 0) return logger('warning', 'SCRIPT', 'No scripts found');

    logger('info', 'SCRIPT', 'Found', scripts.length.toString(), 'scripts');

    for (let i = 0; i < scripts.length; i++) {
        if (![0, 3].includes(i)) await checkScript(scripts[i], i, 'extraStuff', [roleIds.extraStuff, roleIds.codeChanges]);
    };
};

async function fetchSupportArticles(file, title, url) {
    let oldSupportArticles = '';

    try {
        oldSupportArticles = readFileSync(`articles/${file}.json`, 'utf-8');
    } catch (error) {
        logger('error', 'ARTICLE', 'Error while reading', `articles/${file}.json`, error);
    };

    let supportArticles = (await axios.get(url)).data?.articles;

    writeFileSync(`articles/${file}.json`, JSON.stringify(supportArticles, null, 4), 'utf-8');
    logger('success', 'ARTICLE', `Fetched ${title} articles`);

    if (oldSupportArticles !== '') {
        oldSupportArticles = JSON.parse(oldSupportArticles);

        let removed = [];
        let added = [];
        let changed = [];

        for (let data of supportArticles) {
            if (!oldSupportArticles.filter(s => s.id === data.id)[0]) added.push(data);
        };

        for (let data of oldSupportArticles) {
            if (!supportArticles.filter(s => s.id === data.id)[0]) removed.push(data);
        };

        for (let data of supportArticles) {
            if (oldSupportArticles.filter(s => s.id === data.id)[0] && (oldSupportArticles.filter(s => s.id === data.id)[0].name !== data.name || oldSupportArticles.filter(s => s.id === data.id)[0].body !== data.body || oldSupportArticles.filter(s => s.id === data.id)[0].title !== data.title)) changed.push(data);
        };

        logger('success', 'ARTICLE', 'Generated diff for', `${file}.json`);

        if (added.length > 0 || removed.length > 0 || changed.length > 0) {
            for (let data of added) {
                const embed = new EmbedMaker(client)
                    .setColor(colors.green)
                    .setTitle(`Added ${title} Article`)
                    .setFields(
                        {
                            name: 'Link',
                            value: data.html_url,
                            inline: false
                        },
                        {
                            name: 'Id',
                            value: data.id.toString(),
                            inline: true
                        },
                        {
                            name: 'Author Id',
                            value: data.author_id.toString(),
                            inline: true
                        },
                        {
                            name: 'Comments Enabled',
                            value: data.comments_disabled ? '❌' : '✅',
                            inline: true
                        },
                        {
                            name: 'Draft',
                            value: data.draft ? '✅' : '❌',
                            inline: true
                        },
                        {
                            name: 'Section Id',
                            value: data.section_id.toString(),
                            inline: true
                        },
                        {
                            name: 'Created At',
                            value: `<t:${Math.floor(new Date(data.created_at).getTime() / 1000)}:R>`,
                            inline: true
                        },
                        {
                            name: 'Name',
                            value: data.name,
                            inline: true
                        },
                        {
                            name: 'Title',
                            value: data.title,
                            inline: true
                        },
                        {
                            name: 'Outdated',
                            value: data.outdated ? '✅' : '❌',
                            inline: true
                        },
                        {
                            name: 'Outdated Locales',
                            value: data.outdated_locales.length > 0 ? data.outdated_locales.join(', ') : 'None',
                            inline: true
                        },
                        {
                            name: 'Tags',
                            value: data.label_names.length > 0 ? data.label_names.join(', ') : 'None',
                            inline: true
                        }
                    );

                webhooks.otherChanges.send({
                    content: `<@&${roleIds.otherChanges}> <@&${roleIds.urlStuff}>`,
                    embeds: [embed]
                });

                // Wait 3 seconds to prevent ratelimit
                await new Promise(resolve => setTimeout(resolve, 3000));
            };

            for (let data of changed) {
                let diffSupportArticleText = '';
                let diffSupportArticle = diffLines(oldSupportArticles.filter(s => s.id === data.id)[0].body, data.body).filter(l => l.added || l.removed);

                diffSupportArticleText = diffSupportArticle.map(line => line.added ? '+ ' + line.value.split('\n').filter(l => l !== '').join('\n+ ') : '- ' + line.value.split('\n').filter(l => l !== '').join('\n- ')).join('\n');

                const embed = new EmbedMaker(client)
                    .setColor(colors.yellow)
                    .setTitle(`Updated ${title} Article`)
                    .setFields(
                        {
                            name: 'Link',
                            value: data.html_url,
                            inline: false
                        },
                        {
                            name: 'Id',
                            value: data.id.toString(),
                            inline: true
                        },
                        {
                            name: 'Author Id',
                            value: data.author_id.toString(),
                            inline: true
                        },
                        {
                            name: 'Comments Enabled',
                            value: data.comments_disabled ? '❌' : '✅',
                            inline: true
                        },
                        {
                            name: 'Draft',
                            value: data.draft ? '✅' : '❌',
                            inline: true
                        },
                        {
                            name: 'Section Id',
                            value: data.section_id.toString(),
                            inline: true
                        },
                        {
                            name: 'Created At',
                            value: `<t:${Math.floor(new Date(data.created_at).getTime() / 1000)}:R>`,
                            inline: true
                        },
                        {
                            name: 'Updated At',
                            value: `<t:${Math.floor(new Date(data.updated_at).getTime() / 1000)}:R>`,
                            inline: true
                        },
                        {
                            name: 'Name',
                            value: data.name,
                            inline: true
                        },
                        {
                            name: 'Title',
                            value: data.title,
                            inline: true
                        },
                        {
                            name: 'Outdated',
                            value: data.outdated ? '✅' : '❌',
                            inline: true
                        },
                        {
                            name: 'Outdated Locales',
                            value: data.outdated_locales.length > 0 ? data.outdated_locales.join(', ') : 'None',
                            inline: true
                        },
                        {
                            name: 'Tags',
                            value: data.label_names.length > 0 ? data.label_names.join(', ') : 'None',
                            inline: true
                        }
                    );

                if (diffSupportArticleText !== '') embed.setDescription(`\`\`\`diff\n${diffSupportArticleText.length > 3500 ? `${diffSupportArticleText.slice(0, 3500)}...` : diffSupportArticleText}\`\`\``);

                webhooks.otherChanges.send({
                    content: `<@&${roleIds.otherChanges}> <@&${roleIds.urlStuff}>`,
                    embeds: [embed]
                });

                // Wait 3 seconds to prevent ratelimit
                await new Promise(resolve => setTimeout(resolve, 3000));
            };

            for (let data of removed) {
                const embed = new EmbedMaker(client)
                    .setColor(colors.red)
                    .setTitle(`Removed ${title} Article`)
                    .setFields(
                        {
                            name: 'Link',
                            value: data.html_url,
                            inline: false
                        },
                        {
                            name: 'Id',
                            value: data.id.toString(),
                            inline: true
                        },
                        {
                            name: 'Author Id',
                            value: data.author_id.toString(),
                            inline: true
                        },
                        {
                            name: 'Comments Enabled',
                            value: data.comments_disabled ? '❌' : '✅',
                            inline: true
                        },
                        {
                            name: 'Draft',
                            value: data.draft ? '✅' : '❌',
                            inline: true
                        },
                        {
                            name: 'Section Id',
                            value: data.section_id.toString(),
                            inline: true
                        },
                        {
                            name: 'Created At',
                            value: `<t:${Math.floor(new Date(data.created_at).getTime() / 1000)}:R>`,
                            inline: true
                        },
                        {
                            name: 'Updated At',
                            value: `<t:${Math.floor(new Date(data.updated_at).getTime() / 1000)}:R>`,
                            inline: true
                        },
                        {
                            name: 'Name',
                            value: data.name,
                            inline: true
                        },
                        {
                            name: 'Title',
                            value: data.title,
                            inline: true
                        },
                        {
                            name: 'Outdated',
                            value: data.outdated ? '✅' : '❌',
                            inline: true
                        },
                        {
                            name: 'Outdated Locales',
                            value: data.outdated_locales.length > 0 ? data.outdated_locales.join(', ') : 'None',
                            inline: true
                        },
                        {
                            name: 'Tags',
                            value: data.label_names.length > 0 ? data.label_names.join(', ') : 'None',
                            inline: true
                        }
                    )

                webhooks.otherChanges.send({
                    content: `<@&${roleIds.otherChanges}> <@&${roleIds.urlStuff}>`,
                    embeds: [embed]
                });

                // Wait 3 seconds to prevent ratelimit
                await new Promise(resolve => setTimeout(resolve, 3000));
            };

            logger('success', 'ARTICLE', 'Generated response for', `${file}.json`);
        };
    };
};

async function fetchSupportSections(file, title, url) {
    let oldSupportSections = '';

    try {
        oldSupportSections = readFileSync(`articles/${file}.json`, 'utf-8');
    } catch (error) {
        try {
            writeFileSync(`articles/${file}.json`, '', 'utf-8');

            oldSupportSections = readFileSync(`articles/${file}.json`, 'utf-8');
        } catch (error) {
            mkdirSync('articles');
            writeFileSync(`articles/${file}.json`, '', 'utf-8');

            oldSupportSections = readFileSync(`articles/${file}.json`, 'utf-8');
        };
    };

    let supportSections = (await axios.get(url)).data?.sections;

    writeFileSync(`articles/${file}.json`, JSON.stringify(supportSections, null, 4), 'utf-8');
    logger('success', 'ARTICLE', `Fetched ${title} sections`);

    if (oldSupportSections !== '') {
        oldSupportSections = JSON.parse(oldSupportSections);

        let removed = [];
        let added = [];
        let changed = [];

        for (let data of supportSections) {
            if (!oldSupportSections.filter(s => s.id === data.id)[0]) added.push(data);
        };

        for (let data of oldSupportSections) {
            if (!supportSections.filter(s => s.id === data.id)[0]) removed.push(data);
        };

        for (let data of supportSections) {
            if (oldSupportSections.filter(s => s.id === data.id)[0] && oldSupportSections.filter(s => s.id === data.id)[0].name !== data.name) changed.push(data);
        };

        logger('success', 'ARTICLE', 'Generated diff for', `${file}.json`);

        if (added.length > 0 || removed.length > 0 || changed.length > 0) {
            for (let data of added) {
                const embed = new EmbedMaker(client)
                    .setColor(colors.green)
                    .setTitle(`Added ${title} Section`)
                    .setFields(
                        {
                            name: 'Link',
                            value: data.html_url,
                            inline: false
                        },
                        {
                            name: 'Id',
                            value: data.id.toString(),
                            inline: true
                        },
                        {
                            name: 'Category Id',
                            value: data.category_id.toString(),
                            inline: true
                        },
                        {
                            name: 'Created At',
                            value: `<t:${Math.floor(new Date(data.created_at).getTime() / 1000)}:R>`,
                            inline: true
                        },
                        {
                            name: 'Name',
                            value: data.name,
                            inline: true
                        },
                        {
                            name: 'Description',
                            value: data.description === '' ? 'None' : data.description,
                            inline: true
                        },
                        {
                            name: 'Outdated',
                            value: data.outdated ? '✅' : '❌',
                            inline: true
                        },
                        {
                            name: 'Parent Section Id',
                            value: data.parent_section_id ?? 'None',
                            inline: true
                        },
                        {
                            name: 'Theme Template',
                            value: data.theme_template,
                            inline: true
                        }
                    )

                webhooks.otherChanges.send({
                    content: `<@&${roleIds.otherChanges}> <@&${roleIds.urlStuff}>`,
                    embeds: [embed]
                });

                // Wait 3 seconds to prevent ratelimit
                await new Promise(resolve => setTimeout(resolve, 3000));
            };

            for (let data of changed) {
                const embed = new EmbedMaker(client)
                    .setColor(colors.yellow)
                    .setTitle(`Updated ${title} Section`)
                    .setFields(
                        {
                            name: 'Link',
                            value: data.html_url,
                            inline: false
                        },
                        {
                            name: 'Id',
                            value: data.id.toString(),
                            inline: true
                        },
                        {
                            name: 'Category Id',
                            value: data.category_id.toString(),
                            inline: true
                        },
                        {
                            name: 'Created At',
                            value: `<t:${Math.floor(new Date(data.created_at).getTime() / 1000)}:R>`,
                            inline: true
                        },
                        {
                            name: 'Updated At',
                            value: `<t:${Math.floor(new Date(data.updated_at).getTime() / 1000)}:R>`,
                            inline: true
                        },
                        {
                            name: 'Name',
                            value: data.name,
                            inline: true
                        },
                        {
                            name: 'Description',
                            value: data.description === '' ? 'None' : data.description,
                            inline: true
                        },
                        {
                            name: 'Outdated',
                            value: data.outdated ? '✅' : '❌',
                            inline: true
                        },
                        {
                            name: 'Parent Section Id',
                            value: data.parent_section_id ?? 'None',
                            inline: true
                        },
                        {
                            name: 'Theme Template',
                            value: data.theme_template,
                            inline: true
                        }
                    )

                webhooks.otherChanges.send({
                    content: `<@&${roleIds.otherChanges}> <@&${roleIds.urlStuff}>`,
                    embeds: [embed]
                });

                // Wait 3 seconds to prevent ratelimit
                await new Promise(resolve => setTimeout(resolve, 3000));
            };

            for (let data of removed) {
                const embed = new EmbedMaker(client)
                    .setColor(colors.red)
                    .setTitle(`Removed ${title} Section`)
                    .setFields(
                        {
                            name: 'Link',
                            value: data.html_url,
                            inline: false
                        },
                        {
                            name: 'Id',
                            value: data.id.toString(),
                            inline: true
                        },
                        {
                            name: 'Category Id',
                            value: data.category_id.toString(),
                            inline: true
                        },
                        {
                            name: 'Created At',
                            value: `<t:${Math.floor(new Date(data.created_at).getTime() / 1000)}:R>`,
                            inline: true
                        },
                        {
                            name: 'Updated At',
                            value: `<t:${Math.floor(new Date(data.updated_at).getTime() / 1000)}:R>`,
                            inline: true
                        },
                        {
                            name: 'Name',
                            value: data.name,
                            inline: true
                        },
                        {
                            name: 'Description',
                            value: data.description === '' ? 'None' : data.description,
                            inline: true
                        },
                        {
                            name: 'Outdated',
                            value: data.outdated ? '✅' : '❌',
                            inline: true
                        },
                        {
                            name: 'Parent Section Id',
                            value: data.parent_section_id ?? 'None',
                            inline: true
                        },
                        {
                            name: 'Theme Template',
                            value: data.theme_template,
                            inline: true
                        }
                    )

                webhooks.otherChanges.send({
                    content: `<@&${roleIds.otherChanges}> <@&${roleIds.urlStuff}>`,
                    embeds: [embed]
                });

                // Wait 3 seconds to prevent ratelimit
                await new Promise(resolve => setTimeout(resolve, 3000));
            };

            logger('success', 'ARTICLE', 'Generated response for', `${file}.json`);
        };
    };
};

async function checkArticles() {
    try {
        await fetchSupportSections('supportSections', 'Support', 'https://hammerandchisel.zendesk.com/api/v2/help_center/en-us/sections');
        await fetchSupportSections('creatorSupportSections', 'Creator Support', 'https://discordcreatorsupport.zendesk.com/api/v2/help_center/en-us/sections');
        await fetchSupportSections('developerSupportSections', 'Developer Support', 'https://discorddevs.zendesk.com/api/v2/help_center/en-us/sections');
        await fetchSupportArticles('supportArticles', 'Support', 'https://hammerandchisel.zendesk.com/api/v2/help_center/en-us/articles');
        await fetchSupportArticles('creatorSupportArticles', 'Creator Support', 'https://discordcreatorsupport.zendesk.com/api/v2/help_center/en-us/articles');
        await fetchSupportArticles('developerSupportArticles', 'Developer Support', 'https://discorddevs.zendesk.com/api/v2/help_center/en-us/articles');
    } catch (error) {
        return logger('error', 'ARTICLE', 'Error checking articles', `${error?.response?.status} ${error?.response?.statusText}\n`, error);
    };
};

async function checkBlogPosts() {
    let oldBlogPosts = '';

    try {
        oldBlogPosts = readFileSync('blog/posts.json', 'utf-8');
    } catch (error) {
        try {
            writeFileSync('blog/posts.json', '[]');

            oldBlogPosts = readFileSync('blog/posts.json', 'utf-8');
            oldBlogPosts = JSON.parse(oldBlogPosts);
        } catch (error) {
            try {
                mkdirSync('blog');
                writeFileSync('blog/posts.json', '[]');

                oldBlogPosts = readFileSync('blog/posts.json', 'utf-8');
                oldBlogPosts = JSON.parse(oldBlogPosts);
            } catch (error) {
                return logger('error', 'BLOG', 'Error checking blog posts', '\n', error);
            };
        };
    };

    let blogPosts = (await axios.get('https://raw.githubusercontent.com/xHyroM/discord-datamining/master/data/blog/posts.json')).data;

    writeFileSync('blog/posts.json', JSON.stringify(blogPosts, null, 4));

    if (typeof oldBlogPosts === 'string') oldBlogPosts = JSON.parse(oldBlogPosts);
    if (oldBlogPosts.length === 0) return logger('success', 'BLOG', 'No blog posts found');

    logger('info', 'BLOG', 'Found', blogPosts.length, 'blog posts');

    let removed = [];
    let added = [];
    let changed = [];

    for (let data of blogPosts) {
        if (!oldBlogPosts.filter(s => s.id === data.id)[0]) added.push(data);
    };

    for (let data of oldBlogPosts) {
        if (!blogPosts.filter(s => s.id === data.id)[0]) removed.push(data);
    };

    for (let data of blogPosts) {
        if (oldBlogPosts.filter(s => s.id === data.id)[0] && (oldBlogPosts.filter(s => s.id === data.id)[0].title !== data.title || oldBlogPosts.filter(s => s.id === data.id)[0].description !== data.description || oldBlogPosts.filter(s => s.id === data.id)[0].body !== data.body)) changed.push(data);
    };

    logger('success', 'BLOG', 'Generated diff for', 'posts.json');

    if (added.length > 0 || removed.length > 0 || changed.length > 0) {
        for (let data of added) {
            try {
                const embed = new EmbedMaker(client)
                    .setColor(colors.green)
                    .setTitle('Added Blog Post')
                    .setFields(
                        {
                            name: 'Link',
                            value: data.link.toString(),
                            inline: false
                        },
                        {
                            name: 'Id',
                            value: data.id.toString(),
                            inline: true
                        },
                        {
                            name: 'Title',
                            value: data.title.toString(),
                            inline: true
                        },
                        {
                            name: 'Description',
                            value: data.description.toString(),
                            inline: false
                        },
                        {
                            name: 'Published At',
                            value: `<t:${Math.floor(new Date(data.pubDate).getTime() / 1000)}:R>`,
                            inline: true
                        }
                    )
                    .setImage(data['media:thumbnail']);

                embed.data.footer.text = 'Powered by xHyroM/discord-datamining';

                webhooks.otherChanges.send({
                    content: `<@&${roleIds.otherChanges}> <@&${roleIds.urlStuff}>`,
                    embeds: [embed]
                });
            } catch (error) {
                logger('error', 'BLOG', 'Error sending webhook', '\n', error, JSON.stringify(data, null, 4));
            };

            // Wait 3 seconds to prevent ratelimit
            await new Promise(resolve => setTimeout(resolve, 3000));
        };

        for (let data of changed) {
            let diffBlogPostText = '';
            let diffBlogPost = diffLines(oldBlogPosts.filter(s => s.id === data.id)[0].body, data.body).filter(l => l.added || l.removed);

            diffBlogPostText = diffBlogPost.map(line => line.added ? '+ ' + line.value.split('\n').filter(l => l !== '').join('\n+ ') : '- ' + line.value.split('\n').filter(l => l !== '').join('\n- ')).join('\n');

            const embed = new EmbedMaker(client)
                .setColor(colors.yellow)
                .setTitle('Updated Blog Post')
                .setFields(
                    {
                        name: 'Link',
                        value: data.link.toString(),
                        inline: false
                    },
                    {
                        name: 'Id',
                        value: data.id.toString(),
                        inline: true
                    },
                    {
                        name: 'Title',
                        value: data.title.toString(),
                        inline: true
                    },
                    {
                        name: 'Description',
                        value: data.description.toString(),
                        inline: false
                    },
                    {
                        name: 'Published At',
                        value: `<t:${Math.floor(new Date(data.pubDate).getTime() / 1000)}:R>`,
                        inline: true
                    }
                )
                .setImage(data['media:thumbnail']);

            embed.data.footer.text = 'Powered by xHyroM/discord-datamining';

            if (diffBlogPost !== '') embed.setDescription(`\`\`\`diff\n${diffBlogPostText}\`\`\``);

            webhooks.otherChanges.send({
                content: `<@&${roleIds.otherChanges}> <@&${roleIds.urlStuff}>`,
                embeds: [embed]
            });

            // Wait 3 seconds to prevent ratelimit
            await new Promise(resolve => setTimeout(resolve, 3000));
        };

        for (let data of removed) {
            const embed = new EmbedMaker(client)
                .setColor(colors.red)
                .setTitle('Removed Blog Post')
                .setFields(
                    {
                        name: 'Link',
                        value: data.link.toString(),
                        inline: false
                    },
                    {
                        name: 'Id',
                        value: data.id.toString(),
                        inline: true
                    },
                    {
                        name: 'Title',
                        value: data.title.toString(),
                        inline: true
                    },
                    {
                        name: 'Description',
                        value: data.description.toString(),
                        inline: false
                    },
                    {
                        name: 'Published At',
                        value: `<t:${Math.floor(new Date(data.pubDate).getTime() / 1000)}:R>`,
                        inline: true
                    }
                )
                .setImage(data['media:thumbnail']);

            embed.data.footer.text = 'Powered by xHyroM/discord-datamining';

            webhooks.otherChanges.send({
                content: `<@&${roleIds.otherChanges}> <@&${roleIds.urlStuff}>`,
                embeds: [embed]
            });

            // Wait 3 seconds to prevent ratelimit
            await new Promise(resolve => setTimeout(resolve, 3000));
        };

        logger('success', 'ARTICLE', 'Generated response for', `posts.json`);
    };
};

async function checkSubdomains() {
    try {
        let oldSubdomains = '';

        try {
            oldSubdomains = JSON.parse(readFileSync('domain/subdomains.json'));
        } catch (error) {
            try {
                writeFileSync('domain/subdomains.json', '[]');

                oldSubdomains = JSON.parse(readFileSync('domain/subdomains.json'));
            } catch (error) {
                try {
                    mkdirSync('domain');
                    writeFileSync('domain/subdomains.json', '[]');

                    oldSubdomains = JSON.parse(readFileSync('domain/subdomains.json'));
                } catch (error) {
                    logger('error', 'SUBDOMAIN', 'Error while checking subdomains', '\n', error);
                };
            };
        };

        let subdomains = (await axios.get('https://raw.githubusercontent.com/xHyroM/discord-datamining/master/data/domains/discord.com.json')).data?.subdomains;

        writeFileSync('domain/subdomains.json', JSON.stringify(subdomains, null, 4));

        if (oldSubdomains === '') return logger('error', 'SUBDOMAIN', 'Subdomains empty');

        let added = subdomains.filter(s => !oldSubdomains.includes(s));
        let removed = oldSubdomains.filter(s => !subdomains.includes(s));

        if (added.length === 0 && removed.length === 0) return logger('warning', 'SUBDOMAIN', 'No subdomain changes');

        logger('info', 'SUBDOMAIN', 'Subdomain changes', `${added.length} added, ${removed.length} removed`);

        webhooks.otherChanges.send({
            content: `<@&${roleIds.otherChanges}> <@&${roleIds.urlStuff}>`,
            embeds: [
                new EmbedMaker(client)
                    .setTitle('Subdomains')
                    .setDescription(`\`\`\`diff\n${removed.map(s => `- https://${s}.discord.com`).join('\n')}\n${added.map(s => `+ https://${s}.discord.com`).join('\n')}\n\`\`\``)
                    .setFooterText('Powered by xHyroM/discord-datamining')
            ]
        }).catch(error => logger('error', 'SUBDOMAIN', 'Error while sending webhook', '\n', error));

        logger('success', 'SUBDOMAIN', 'Generated response for', 'subdomains.json');
    } catch (error) {
        logger('error', 'SUBDOMAIN', 'Error while checking subdomains', '\n', error?.rawError);
    };
};

async function check() {
    await checkScripts();
    await checkArticles();
    await checkBlogPosts();
    await checkSubdomains();
};

client.on('ready', async () => {
    logger('info', 'BOT', 'Logged in as', client.user.tag);
    logger('info', 'COMMAND', 'Registering commands');

    axios.put(`https://discord.com/api/v10/applications/${client.user.id}/commands`, client.commands.map(command => command.data.toJSON()), {
        headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bot ${process.env.DISCORD_TOKEN}`
        }
    }).then(() => logger('success', 'COMMAND', 'Registered commands')).catch(error => logger('error', 'COMMAND', 'Error while registering commands', `${error?.response?.status} ${error?.response?.statusText}\n`, JSON.stringify(error?.response?.data ?? error, null, 4)));

    check();
    setInterval(check, 1000 * 60 * 5);
});

client.on('interactionCreate', async interaction => {
    if (interaction.isCommand() || interaction.isContextMenuCommand()) {
        logger('debug', 'COMMAND', 'Received command', `${interaction.commandName} (${interaction.commandId})`, 'from', interaction.guild ? `${interaction.guild.name} (${interaction.guild.id})` : 'DMs', 'by', `${interaction.user.tag} (${interaction.user.id})`);

        const command = client.commands.get(interaction.commandName);

        if (!command) {
            logger('warning', 'COMMAND', 'Command ', interaction.commandName, 'not found');

            return interaction.reply({
                content: localize(interaction.locale, 'NOT_FOUND', 'Command'),
                ephemeral: true
            });
        };
        if (command.category === 'Owner' && interaction.user.id !== ownerId) {
            logger('debug', 'COMMAND', 'Command', interaction.commandName, 'blocked for', interaction.user.tag, 'because it is owner only');

            return interaction.reply({
                content: localize(interaction.locale, 'OWNER_ONLY'),
                ephemeral: true
            });
        };
        if (command.category === 'Developer' && !developerIds.includes(interaction.user.id) && interaction.user.id !== ownerId) {
            logger('debug', 'COMMAND', 'Command', interaction.commandName, 'blocked for', interaction.user.tag, 'because it is developer only');

            return interaction.reply({
                content: localize(interaction.locale, 'DEVELOPER_ONLY'),
                ephemeral: true
            });
        };

        try {
            await command.execute(interaction);
        } catch (error) {
            logger('error', 'COMMAND', 'Error while executing command:', `${error.message}\n`, error.stack);

            return interaction.reply({
                content: localize(interaction.locale, 'COMMAND_ERROR', 'command', error.message),
                ephemeral: true
            }).catch(() => interaction.editReply({
                content: localize(interaction.locale, 'COMMAND_ERROR', 'command', error.message)
            }).catch(() => logger('error', 'COMMAND', 'Error while sending error message', '\n', error)));
        };
    } else if (interaction.isMessageComponent()) {
        logger('debug', 'COMMAND', 'Received message component', `${interaction.customId} (${interaction.componentType})`, 'from', interaction.guild ? `${interaction.guild.name} (${interaction.guild.id})` : 'DMs', 'by', `${interaction.user.tag} (${interaction.user.id})`);

        try {
            let [userId, customId, ...args] = interaction.customId.split(':');
            let locale = interaction.locale;

            if (userId !== interaction.user.id) return interaction.reply({
                content: localize(locale, 'COMPONENT_NOT_YOURS'),
                ephemeral: true
            });

            let guildId = interaction.guildId;

            const home = await new Home(guildId).setup();
            const automod = await new AutoMod(guildId).setup();

            switch (customId) {
                case 'settings':
                    switch (interaction.values[0]) {
                        case 'home':
                            interaction.update({
                                embeds: [
                                    new EmbedMaker(client)
                                        .setColor(home.set ? home.data.enabled ? colors.green : colors.red : colors.yellow)
                                        .setTitle(`${emojis.home} ${localize(locale, 'HOME')} ${beta.home ? emojis.beta : ''}`)
                                        .setFields(
                                            {
                                                name: localize(locale, 'STATUS'),
                                                value: home.data?.enabled ? `${emojis.enabled} ${localize(locale, 'ENABLED')}` : `${emojis.disabled} ${localize(locale, 'DISABLED')}`,
                                                inline: true
                                            },
                                            {
                                                name: localize(locale, 'CHANNEL'),
                                                value: home.data?.channel ? `<#${home.data.channel}>` : localize(locale, 'NOT_SET'),
                                                inline: true
                                            },
                                            {
                                                name: localize(locale, 'MIN_INTERACTIONS'),
                                                value: home.data.minInteractions.toString(),
                                                inline: true
                                            }
                                        )
                                ],
                                components: [
                                    new ActionRowBuilder()
                                        .setComponents(
                                            ...(!home.set ? [
                                                new ButtonBuilder()
                                                    .setCustomId(`${interaction.user.id}:home_setup`)
                                                    .setLabel(localize(locale, 'QUICK_SETUP'))
                                                    .setStyle(ButtonStyle.Success)
                                            ] : []),
                                            new ButtonBuilder()
                                                .setCustomId(`${interaction.user.id}:home_${home.data?.enabled ? 'disable' : 'enable'}`)
                                                .setLabel(localize(locale, home.data?.enabled ? 'DISABLE' : 'ENABLE'))
                                                .setStyle(home.data?.enabled ? ButtonStyle.Danger : ButtonStyle.Success),
                                            new ButtonBuilder()
                                                .setCustomId(`${interaction.user.id}:home_channel`)
                                                .setLabel(localize(locale, 'SET_CHANNEL'))
                                                .setStyle(ButtonStyle.Primary),
                                            new ButtonBuilder()
                                                .setCustomId(`${interaction.user.id}:home_min_interactions`)
                                                .setLabel(localize(locale, 'SET_MIN_INTERACTIONS'))
                                                .setStyle(ButtonStyle.Primary),
                                            ...(home.set ? [
                                                new ButtonBuilder()
                                                    .setCustomId(`${interaction.user.id}:home_reset`)
                                                    .setLabel(localize(locale, 'RESET_DATA'))
                                                    .setStyle(ButtonStyle.Danger)
                                            ] : [])
                                        )
                                ]
                            });
                            break;
                        case 'automod':
                            if (!interaction.memberPermissions.has('ManageMessages') || !interaction.memberPermissions.has('ModerateMembers')) return interaction.update({
                                content: localize(locale, 'USER_MISSING_PERMISSIONS', 'Manage Messages, Timeout Members')
                            });
                            if (!interaction.appPermissions.has('ManageMessages') || !interaction.appPermissions.has('ModerateMembers')) return interaction.update({
                                content: localize(locale, 'BOT_MISSING_PERMISSIONS', 'Manage Messages, Timeout Members')
                            });

                            interaction.update({
                                embeds: [
                                    new EmbedMaker(client)
                                        .setColor(automod.set ? automod.data.enabled ? colors.green : colors.red : colors.yellow)
                                        .setTitle(`${emojis.automod} ${localize(locale, 'AUTOMOD')} ${beta.automod ? emojis.beta : ''}`)
                                        .setFields(
                                            {
                                                name: localize(locale, 'STATUS'),
                                                value: automod.data?.enabled ? `${emojis.enabled} ${localize(locale, 'ENABLED')}` : `${emojis.disabled} ${localize(locale, 'DISABLED')}`,
                                                inline: true
                                            },
                                            {
                                                name: localize(locale, 'BYPASS_ROLES'),
                                                value: automod.data?.bypassRoles?.length > 0 ? automod.data?.bypassRoles.map(role => `<@&${role}>`).join(', ') : localize(locale, 'NONE'),
                                                inline: false
                                            },
                                            {
                                                name: localize(locale, 'BYPASS_CHANNELS'),
                                                value: automod.data?.bypassChannels?.length > 0 ? automod.data?.bypassChannels.map(channel => `<#${channel}>`).join(', ') : localize(locale, 'NONE'),
                                                inline: false
                                            }
                                        )
                                        .setDescription(`# ${localize(locale, 'RULES')}\n${automod && automod.data.rules.length > 0 ? automod.data?.rules?.map((rule, index) => `${index + 1}. ${rule}`).join('\n').slice(0, 3500) : localize(locale, 'NONE')} `)
                                ],
                                components: [
                                    new ActionRowBuilder()
                                        .setComponents(
                                            ...(!automod.set ? [
                                                new ButtonBuilder()
                                                    .setCustomId(`${interaction.user.id}:automod_setup`)
                                                    .setLabel(localize(locale, 'QUICK_SETUP'))
                                                    .setStyle(ButtonStyle.Success)
                                            ] : []),
                                            new ButtonBuilder()
                                                .setCustomId(`${interaction.user.id}:automod_toggle`)
                                                .setLabel(localize(locale, automod.data?.enabled ? 'DISABLE' : 'ENABLE'))
                                                .setStyle(automod.data?.enabled ? ButtonStyle.Danger : ButtonStyle.Success),
                                            new ButtonBuilder()
                                                .setCustomId(`${interaction.user.id}:automod_sync`)
                                                .setLabel(localize(locale, 'SYNC_RULES'))
                                                .setStyle(ButtonStyle.Primary),
                                            new ButtonBuilder()
                                                .setCustomId(`${interaction.user.id}:automod_add_rule`)
                                                .setLabel(localize(locale, 'ADD_RULE'))
                                                .setStyle(ButtonStyle.Primary),
                                            new ButtonBuilder()
                                                .setCustomId(`${interaction.user.id}:automod_remove_rule`)
                                                .setLabel(localize(locale, 'REMOVE_RULE'))
                                                .setStyle(ButtonStyle.Primary)
                                        ),
                                    new ActionRowBuilder()
                                        .setComponents(
                                            new ButtonBuilder()
                                                .setCustomId(`${interaction.user.id}:automod_bypass_roles`)
                                                .setLabel(localize(locale, 'SET_BYPASS_ROLES'))
                                                .setStyle(ButtonStyle.Primary),
                                            new ButtonBuilder()
                                                .setCustomId(`${interaction.user.id}:automod_bypass_channels`)
                                                .setLabel(localize(locale, 'SET_BYPASS_CHANNELS'))
                                                .setStyle(ButtonStyle.Primary),
                                            new ButtonBuilder()
                                                .setCustomId(`${interaction.user.id}:automod_test`)
                                                .setLabel(localize(locale, 'TEST'))
                                                .setStyle(ButtonStyle.Primary),
                                            ...(automod.set ? [
                                                new ButtonBuilder()
                                                    .setCustomId(`${interaction.user.id}:automod_reset`)
                                                    .setLabel(localize(locale, 'RESET_DATA'))
                                                    .setStyle(ButtonStyle.Danger)
                                            ] : [])
                                        )
                                ]
                            });
                            break;
                    };
                    break;
                case 'home_setup':
                    if (!interaction.member.permissions.has('ManageChannels')) return interaction.reply({
                        content: localize(locale, 'USER_MISSING_PERMISSIONS', 'Manage Channels'),
                        ephemeral: true
                    });
                    if (!interaction.appPermissions.has('ManageChannels') || !interaction.appPermissions.has('ManageWebhooks') || !interaction.appPermissions.has('ManageMessages')) return interaction.reply({
                        content: localize(interaction.locale, 'BOT_MISSING_PERMISSIONS', 'Manage Channels, Manage Webhooks, Manage Messages'),
                        ephemeral: true
                    });

                    interaction.update({
                        content: 'Setting up home...',
                        embeds: [],
                        components: []
                    });

                    let channel = await interaction.guild.channels.create({
                        type: ChannelType.GuildText,
                        name: 'home',
                        permissionOverwrites: [
                            {
                                id: interaction.guildId,
                                deny: PermissionFlagsBits.SendMessages
                            }
                        ]
                    });
                    let webhook = await channel.createWebhook({ name: 'Home' });

                    channel.send('**There are no Highlights to show you yet!**\nBut you could write some!').catch(() => { });

                    await db.set(`guilds.${interaction.guildId}.home`, {
                        enabled: true,
                        channel: channel.id,
                        webhook: webhook.url
                    });

                    interaction.editReply({
                        content: localize(locale, 'HOME_SETUP_SUCCESS', `<#${channel.id}>`)
                    });
                    break;
                case 'home_enable':
                    await interaction.deferUpdate();
                    await home.toggle();

                    interaction.editReply({
                        content: localize(locale, 'SETTING_ENABLE_SUCCESS', localize(locale, 'HOME')),
                        embeds: [],
                        components: []
                    });
                    break;
                case 'home_disable':
                    await interaction.deferUpdate();
                    await home.toggle();

                    interaction.editReply({
                        content: localize(locale, 'SETTING_DISABLE_SUCCESS', localize(locale, 'HOME')),
                        embeds: [],
                        components: []
                    });
                    break;
                case 'home_channel':
                    interaction.update({
                        embeds: [],
                        components: [
                            new ActionRowBuilder()
                                .setComponents(
                                    new ChannelSelectMenuBuilder()
                                        .setCustomId(`${interaction.user.id}:home_channel_select`)
                                        .setPlaceholder(localize(locale, 'CHANNEL_SELECT'))
                                        .setChannelTypes(ChannelType.GuildText)
                                )
                        ]
                    });
                    break;
                case 'home_channel_select':
                    await interaction.deferUpdate();

                    let channelId = interaction.values[0];

                    await home.setChannel(channelId);

                    interaction.editReply({
                        content: localize(locale, 'SETTING_CHANNEL_SUCCESS', localize(locale, 'HOME'), `<#${channelId}>`),
                        embeds: [],
                        components: []
                    });
                    break;
                case 'home_reset':
                    await interaction.deferUpdate();
                    await home.delete();

                    interaction.editReply({
                        content: localize(locale, 'SETTING_RESET_SUCCESS', localize(locale, 'HOME')),
                        embeds: [],
                        components: []
                    });
                    break;
                case 'home_min_interactions':
                    interaction.showModal(
                        new ModalBuilder()
                            .setCustomId(`home_min_interactions_modal:${guildId}`)
                            .setTitle(localize(locale, 'SET_MIN_INTERACTIONS'))
                            .setComponents(
                                new ActionRowBuilder()
                                    .setComponents(
                                        new TextInputBuilder()
                                            .setCustomId('count')
                                            .setLabel(localize(locale, 'MIN_INTERACTIONS'))
                                            .setPlaceholder('5')
                                            .setValue(home.data.minInteractions.toString())
                                            .setRequired(true)
                                            .setMinLength(1)
                                            .setMaxLength(2)
                                            .setStyle(TextInputStyle.Short)
                                    )
                            )
                    );
                    break;
                case 'automod_setup':
                    await interaction.deferUpdate();

                    let rulesChannel = interaction.guild.rulesChannel;
                    let messages = await rulesChannel.messages.fetch({ limit: 50 });

                    await automod.sync(messages.toJSON().map(m => m.content));
                    await automod.toggle();

                    interaction.editReply({
                        content: localize(locale, 'AUTOMOD_SETUP_SUCCESS'),
                        embeds: [],
                        components: []
                    });
                    break;
                case 'automod_sync':
                    await interaction.deferUpdate();

                    let rulesChannel2 = interaction.guild.rulesChannel;
                    let messages2 = await rulesChannel2.messages.fetch({ limit: 50 });

                    await automod.sync(messages2.toJSON().map(m => m.content));

                    interaction.editReply({
                        content: localize(locale, 'SYNC_RULES_SUCCESS'),
                        embeds: [],
                        components: []
                    });
                    break;
                case 'automod_toggle':
                    await interaction.deferUpdate();
                    await automod.toggle();

                    interaction.editReply({
                        content: localize(locale, `AUTOMOD_${automod.data.enabled ? 'ENABLE' : 'DISABLE'}_SUCCESS`, localize(locale, 'AUTOMOD')),
                        embeds: [],
                        components: []
                    });
                    break;
                case 'automod_reset':
                    await interaction.deferUpdate();
                    await automod.delete();

                    interaction.editReply({
                        content: localize(locale, 'SETTING_RESET_SUCCESS', localize(locale, 'AUTOMOD')),
                        embeds: [],
                        components: []
                    });
                    break;
                case 'automod_test':
                    interaction.showModal(
                        new ModalBuilder()
                            .setCustomId('automod_test_modal')
                            .setTitle(localize(locale, 'TEST'))
                            .setComponents(
                                new ActionRowBuilder()
                                    .setComponents(
                                        new TextInputBuilder()
                                            .setCustomId('message')
                                            .setLabel(localize(locale, 'TEST_MESSAGE'))
                                            .setStyle(TextInputStyle.Paragraph)
                                            .setRequired(true)
                                    )
                            )
                    );
                    break;
                case 'automod_add_rule':
                    interaction.showModal(
                        new ModalBuilder()
                            .setCustomId('automod_add_rule_modal')
                            .setTitle(localize(locale, 'ADD_RULE'))
                            .setComponents(
                                new ActionRowBuilder()
                                    .setComponents(
                                        new TextInputBuilder()
                                            .setCustomId('rule')
                                            .setLabel(localize(locale, 'RULE'))
                                            .setPlaceholder('No swearing allowed.')
                                            .setRequired(true)
                                            .setStyle(TextInputStyle.Paragraph)
                                    )
                            )
                    );
                    break;
                case 'automod_remove_rule':
                    interaction.showModal(
                        new ModalBuilder()
                            .setCustomId('automod_remove_rule_modal')
                            .setTitle(localize(locale, 'REMOVE_RULE'))
                            .setComponents(
                                new ActionRowBuilder()
                                    .setComponents(
                                        new TextInputBuilder()
                                            .setCustomId('rule')
                                            .setLabel(localize(locale, 'RULE_INDEX'))
                                            .setPlaceholder('1')
                                            .setRequired(true)
                                            .setMinLength(1)
                                            .setMaxLength(2)
                                            .setStyle(TextInputStyle.Short)
                                    )
                            )
                    );
                    break;
                case 'automod_bypass_roles':
                    interaction.reply({
                        embeds: [],
                        components: [
                            new ActionRowBuilder()
                                .setComponents(
                                    new RoleSelectMenuBuilder()
                                        .setCustomId(`${interaction.user.id}:automod_bypass_roles_select`)
                                        .setPlaceholder(localize(locale, 'ROLES_SELECT'))
                                        .setMaxValues(interaction.guild.roles.cache.size > 25 ? 25 : interaction.guild.roles.cache.size)
                                )
                        ]
                    });
                    break;
                case 'automod_bypass_roles_select':
                    await interaction.deferUpdate();

                    let roleIds = interaction.values;

                    await automod.setBypassRoles(roleIds);

                    interaction.editReply({
                        content: localize(locale, 'BYPASS_ROLES_SUCCESS', roleIds.map(id => `<@&${id}>`).join(', ')),
                        embeds: [],
                        components: []
                    });
                    break;
                case 'automod_bypass_channels':
                    interaction.reply({
                        embeds: [],
                        components: [
                            new ActionRowBuilder()
                                .setComponents(
                                    new ChannelSelectMenuBuilder()
                                        .setCustomId(`${interaction.user.id}:automod_bypass_channels_select`)
                                        .setPlaceholder(localize(locale, 'CHANNELS_SELECT'))
                                        .setMaxValues(interaction.guild.channels.cache.size > 25 ? 25 : interaction.guild.channels.cache.size)
                                        .setChannelTypes(ChannelType.GuildText, ChannelType.GuildForum)
                                )
                        ]
                    });
                    break;
                case 'automod_bypass_channels_select':
                    await interaction.deferUpdate();

                    let channelIds = interaction.values;

                    await automod.setBypassChannels(channelIds);

                    interaction.editReply({
                        content: localize(locale, 'BYPASS_CHANNELS_SUCCESS', channelIds.map(id => `<#${id}>`).join(', ')),
                        embeds: [],
                        components: []
                    });
                    break;
                default:
                    logger('warning', 'COMMAND', 'Message component', interaction.customId, 'not found');
            };
        } catch (error) {
            logger('error', 'COMMAND', 'Error while executing message component:', `${error.message}\n`, error.stack);

            return interaction.reply({
                content: localize(interaction.locale, 'COMMAND_ERROR', 'message component', error.message),
                ephemeral: true
            }).catch(() => interaction.editReply({
                content: localize(interaction.locale, 'COMMAND_ERROR', 'message component', error.message)
            }));
        }
    } else if (interaction.isModalSubmit()) {
        logger('debug', 'COMMAND', 'Received modal submit', interaction.customId, 'from', interaction.guild ? `${interaction.guild.name} (${interaction.guild.id})` : 'DMs', 'by', `${interaction.user.tag} (${interaction.user.id})`);

        try {
            let [customId, ...args] = interaction.customId.split(':');
            let locale = interaction.locale;

            const home = await new Home(interaction.guildId).setup();
            const automod = await new AutoMod(interaction.guildId).setup();

            switch (customId) {
                case 'home_min_interactions_modal':
                    await interaction.deferUpdate();

                    let minInteractions = parseInt(interaction.fields.getTextInputValue('count'));

                    if (isNaN(minInteractions)) return interaction.editReply(localize(interaction.locale, 'INVALID_NUMBER'));

                    await home.setMinInteractions(minInteractions);

                    interaction.editReply({
                        content: localize(locale, 'SETTING_MIN_INTERACTIONS_SUCCESS', minInteractions),
                        embeds: [],
                        components: []
                    });
                    break;
                case 'automod_test_modal':
                    await interaction.deferReply({ ephemeral: true });

                    let message = interaction.fields.getTextInputValue('message');
                    let result = await automod.check({
                        content: message,
                        author: interaction.user,
                        channel: {
                            name: 'test-channel'
                        }
                    }, true);

                    interaction.editReply(`${localize(locale, 'AUTOMOD_RESPONSE')}\n${result}`);
                    break;
                case 'automod_add_rule_modal':
                    await interaction.deferUpdate();

                    let rule = interaction.fields.getTextInputValue('rule');

                    await automod.addRule(rule);

                    interaction.editReply({
                        content: localize(locale, 'SETTING_ADD_RULE_SUCCESS', rule),
                        embeds: [],
                        components: []
                    });
                    break;
                case 'automod_remove_rule_modal':
                    await interaction.deferUpdate();

                    let index = parseInt(interaction.fields.getTextInputValue('rule'));

                    if (isNaN(index)) return interaction.editReply(localize(interaction.locale, 'INVALID_NUMBER'));

                    await automod.removeRule(index - 1);

                    interaction.editReply({
                        content: localize(locale, 'SETTING_REMOVE_RULE_SUCCESS'),
                        embeds: [],
                        components: []
                    });
                    break;
                default:
                    logger('warning', 'COMMAND', 'Modal', interaction.customId, 'not found');

                    return interaction.reply({
                        content: localize(interaction.locale, 'NOT_FOUND', 'Modal'),
                        ephemeral: true
                    });
            };
        } catch (error) {
            logger('error', 'COMMAND', 'Error while executing modal:', `${error.message}\n`, error.stack);

            return interaction.reply({
                content: localize(interaction.locale, 'COMMAND_ERROR', 'modal', error.message),
                ephemeral: true
            }).catch(() => interaction.editReply({
                content: localize(interaction.locale, 'COMMAND_ERROR', 'modal', error.message)
            }));
        };
    } else if (interaction.isAutocomplete()) {
        logger('debug', 'COMMAND', 'Received autocomplete of', `${interaction.commandName} (${interaction.commandId})`, 'from', interaction.guild ? `${interaction.guild.name} (${interaction.guild.id})` : 'DMs', 'by', `${interaction.user.tag} (${interaction.user.id})`);

        const command = client.commands.get(interaction.commandName);

        if (!command) return logger('warning', 'COMMAND', 'Command', interaction.commandName, 'not found');

        try {
            await command.autocomplete(interaction);
        } catch (error) {
            logger('error', 'COMMAND', 'Error while executing autocomplete:', `${error.message}\n`, error.stack);
        };
    };
});

client.on('messageCreate', async message => {
    if (!message.guild || !message.member) return;
    if (message.type === 0 && message.content !== '' && message.reference?.messageId) {
        const home = await new Home(message.guildId).setup();

        home.check('reply', message);
    };
    if (message.type === 0 && message.content !== '' && !message.author.bot && !message.member.permissions.has('ManageMessages') && message.channel.type !== ChannelType.GuildAnnouncement) {
        const automod = await new AutoMod(message.guildId).setup();

        if (automod.data.enabled && automod.usable && !automod.data.bypassChannels.includes(message.channelId) && !automod.data.bypassChannels.includes(message.channel.parentId) && !automod.data.bypassRoles.filter(role => message.member.roles.cache.get(role))[0]) await automod.check(message);
    };
});

client.on('messageReactionAdd', async (reaction, user) => {
    if (!reaction.message.guild) return;

    const home = await new Home(reaction.message.guildId).setup();

    home.check('reaction', reaction, user);
});

client.login(process.env.DISCORD_TOKEN);