const { 
    Client, 
    GatewayIntentBits, 
    EmbedBuilder, 
    ActionRowBuilder, 
    ButtonBuilder, 
    ButtonStyle, 
    PermissionFlagsBits, 
    ChannelType 
} = require('discord.js');

const fs = require('fs');
const path = require('path');
const axios = require('axios');
const express = require('express');

// ===============================
// ⚙️ CONFIGURATION - SET THESE!
// ===============================
const OAUTH_CONFIG = {
     clientId: '1436420436572373112',
    clientSecret: 'Xj0Z4yuFiarBo5jJ38tBOMilXLIpEETS', // REGENERATE THIS!
    redirectUri: 'https://bandit-store-gfx-and-more.onrender.com/callback' // Replace with your public URL
};

const BOT_TOKEN = 'MTQzNjQyMDQzNjU3MjM3MzExMg.G8dBS6.hOVSlq07tD63qyd771tMHtUlD62HeIYmvp0_Z0'; // REGENERATE THIS IN DISCORD DEVELOPER PORTAL!

// Load config file
const configPath = path.join(__dirname, 'config.json');
let config = fs.existsSync(configPath)
    ? JSON.parse(fs.readFileSync(configPath, 'utf8'))
    : { guilds: {}, userTokens: {} };

function saveConfig() {
    fs.writeFileSync(configPath, JSON.stringify(config, null, 2));
}

// Store invites in memory
const invites = new Map();

// ===============================
// 🤖 Discord Client Setup
// ===============================
const client = new Client({
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMembers,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.GuildInvites
    ]
});

// ===============================
// 🔐 OAuth2 Helper Functions
// ===============================

// Generate OAuth2 authorization URL
function generateAuthUrl(userId, guildId, action = 'verify') {
    const state = Buffer.from(JSON.stringify({ userId, guildId, action })).toString('base64');
    const params = new URLSearchParams({
        client_id: OAUTH_CONFIG.clientId,
        redirect_uri: OAUTH_CONFIG.redirectUri,
        response_type: 'code',
        scope: 'identify guilds.join',
        state: state
    });
    return `https://discord.com/api/oauth2/authorize?${params.toString()}`;
}

// Exchange authorization code for access token
async function exchangeCode(code) {
    try {
        const response = await axios.post('https://discord.com/api/v10/oauth2/token', 
            new URLSearchParams({
                client_id: OAUTH_CONFIG.clientId,
                client_secret: OAUTH_CONFIG.clientSecret,
                grant_type: 'authorization_code',
                code: code,
                redirect_uri: OAUTH_CONFIG.redirectUri
            }), {
                headers: { 'Content-Type': 'application/x-www-form-urlencoded' }
            }
        );
        return response.data;
    } catch (error) {
        console.error('❌ Error exchanging code:', error.response?.data || error.message);
        return null;
    }
}

// Add user to guild using their OAuth2 token
async function addUserToGuild(guildId, userId, accessToken) {
    try {
        const response = await axios.put(
            `https://discord.com/api/v10/guilds/${guildId}/members/${userId}`,
            { access_token: accessToken },
            {
                headers: {
                    'Authorization': `Bot ${client.token}`,
                    'Content-Type': 'application/json'
                }
            }
        );
        return { success: true, data: response.data };
    } catch (error) {
        console.error('❌ Error adding user to guild:', error.response?.data || error.message);
        return { 
            success: false, 
            error: error.response?.data?.message || error.message 
        };
    }
}

// ===============================
// ✅ Cache Invites on Ready
// ===============================
client.once('ready', async () => {
    console.log(`✅ Logged in as ${client.user.tag}`);
    client.user.setActivity('Verification System', { type: 3 });

    // Cache all invites for all guilds
    for (const guild of client.guilds.cache.values()) {
        try {
            const guildInvites = await guild.invites.fetch();
            invites.set(guild.id, new Map(guildInvites.map(invite => [invite.code, invite.uses])));
            console.log(`📋 Cached ${guildInvites.size} invites for ${guild.name}`);
        } catch (error) {
            console.error(`❌ Could not fetch invites for ${guild.name}:`, error);
        }
    }

    // Start OAuth callback server
    startCallbackServer();
    
    // Register slash commands
    await registerCommands();
});

// ===============================
// ✅ Track New Invites
// ===============================
client.on('inviteCreate', invite => {
    const guildInvites = invites.get(invite.guild.id) || new Map();
    guildInvites.set(invite.code, invite.uses);
    invites.set(invite.guild.id, guildInvites);
});

// ===============================
// ✅ Track Deleted Invites
// ===============================
client.on('inviteDelete', invite => {
    const guildInvites = invites.get(invite.guild.id);
    if (guildInvites) {
        guildInvites.delete(invite.code);
    }
});

// ===============================
// ✅ Track Member Join and Find Inviter
// ===============================
client.on('guildMemberAdd', async member => {
    const guildId = member.guild.id;
    
    // Store inviter info in config
    if (!config.guilds[guildId]) {
        config.guilds[guildId] = {};
    }
    if (!config.guilds[guildId].invites) {
        config.guilds[guildId].invites = {};
    }

    try {
        const newInvites = await member.guild.invites.fetch();
        const oldInvites = invites.get(guildId) || new Map();
        
        // Find which invite was used
        const usedInvite = newInvites.find(invite => {
            const oldUses = oldInvites.get(invite.code) || 0;
            return invite.uses > oldUses;
        });

        // Update cache
        invites.set(guildId, new Map(newInvites.map(invite => [invite.code, invite.uses])));

        if (usedInvite) {
            // Store inviter info for this member
            config.guilds[guildId].invites[member.id] = {
                inviterId: usedInvite.inviter.id,
                inviterTag: usedInvite.inviter.tag
            };
            saveConfig();
            console.log(`📥 ${member.user.tag} was invited by ${usedInvite.inviter.tag}`);
        }
    } catch (error) {
        console.error('❌ Error tracking invite:', error);
    }
});

// ===============================
// ✅ Slash Command Handler
// ===============================
client.on('interactionCreate', async interaction => {
    if (!interaction.isChatInputCommand()) return;

    const guildId = interaction.guild.id;
    const member = interaction.member;

    // ===============================
    // ✅ /setup command
    // ===============================
    if (interaction.commandName === 'setup') {
        if (!member.permissions.has(PermissionFlagsBits.Administrator)) {
            return interaction.reply({
                content: '❌ You need Administrator permission!',
                ephemeral: true
            });
        }

        await interaction.deferReply({ ephemeral: true });

        // Init config if missing
        if (!config.guilds[guildId]) {
            config.guilds[guildId] = {
                verificationChannel: null,
                verifiedRole: null,
                welcomeChannel: null,
                logChannel: null,
                invites: {},
                pullEnabled: false
            };
        }

        const guild = interaction.guild;

        // Create verification channel
        let verificationChannel = guild.channels.cache.find(c => c.name === '🔐verification');
        if (!verificationChannel) {
            verificationChannel = await guild.channels.create({
                name: '🔐verification',
                type: ChannelType.GuildText,
                permissionOverwrites: [
                    { id: guild.id, allow: [PermissionFlagsBits.ViewChannel], deny: [PermissionFlagsBits.SendMessages] },
                    { id: client.user.id, allow: [PermissionFlagsBits.SendMessages] }
                ]
            });
        }

        // Create welcome channel
        let welcomeChannel = guild.channels.cache.find(c => c.name === '👋welcome');
        if (!welcomeChannel) {
            welcomeChannel = await guild.channels.create({
                name: '👋welcome',
                type: ChannelType.GuildText
            });
        }

        // Create log channel
        let logChannel = guild.channels.cache.find(c => c.name === '📋verification-logs');
        if (!logChannel) {
            logChannel = await guild.channels.create({
                name: '📋verification-logs',
                type: ChannelType.GuildText,
                permissionOverwrites: [
                    { id: guild.id, deny: [PermissionFlagsBits.ViewChannel] },
                    { id: client.user.id, allow: [PermissionFlagsBits.SendMessages, PermissionFlagsBits.ViewChannel] }
                ]
            });
        }

        // Save config
        config.guilds[guildId].verificationChannel = verificationChannel.id;
        config.guilds[guildId].welcomeChannel = welcomeChannel.id;
        config.guilds[guildId].logChannel = logChannel.id;
        saveConfig();

        // Cache invites for this guild
        try {
            const guildInvites = await guild.invites.fetch();
            invites.set(guild.id, new Map(guildInvites.map(invite => [invite.code, invite.uses])));
        } catch (error) {
            console.error('❌ Error caching invites:', error);
        }

        // Send panel
        const embed = new EmbedBuilder()
            .setColor('#5865F2')
            .setTitle('🔐 Server Verification')
            .setDescription('Click the button below to verify yourself and gain access to the server.')
            .setTimestamp();

        const button = new ButtonBuilder()
            .setCustomId('verify')
            .setLabel('✅ Verify Me')
            .setStyle(ButtonStyle.Success);

        const row = new ActionRowBuilder().addComponents(button);

        await verificationChannel.send({ embeds: [embed], components: [row] });

        await interaction.editReply({
            content: '✅ Setup complete!\nNow set the verified role using `/setverifiedrole <role>`.'
        });
    }

    // ===============================
    // ✅ /setverifiedrole command
    // ===============================
    if (interaction.commandName === 'setverifiedrole') {
        if (!member.permissions.has(PermissionFlagsBits.Administrator)) {
            return interaction.reply({
                content: '❌ You need Administrator permission!',
                ephemeral: true
            });
        }

        const role = interaction.options.getRole('role');

        if (!config.guilds[guildId]) {
            config.guilds[guildId] = {};
        }

        config.guilds[guildId].verifiedRole = role.id;
        saveConfig();

        return interaction.reply({
            content: `✅ Verified role set to **${role.name}**`,
            ephemeral: true
        });
    }

    // ===============================
    // 🆕 /authorize command
    // ===============================
    if (interaction.commandName === 'authorize') {
        const authUrl = generateAuthUrl(interaction.user.id, guildId, 'authorize');
        
        const embed = new EmbedBuilder()
            .setColor('#5865F2')
            .setTitle('🔐 Authorization Required')
            .setDescription('To use the `/pull` feature, you need to authorize the bot to add you to servers.\n\n**Click the button below to authorize:**')
            .addFields({
                name: '⚠️ Important',
                value: 'This allows server admins to pull you into their servers using the `/pull` command. Only authorize if you trust this bot!'
            })
            .setTimestamp();

        const button = new ButtonBuilder()
            .setLabel('🔗 Authorize')
            .setStyle(ButtonStyle.Link)
            .setURL(authUrl);

        const row = new ActionRowBuilder().addComponents(button);

        return interaction.reply({
            embeds: [embed],
            components: [row],
            ephemeral: true
        });
    }

    // ===============================
    // 🆕 /pull command
    // ===============================
    if (interaction.commandName === 'pull') {
        if (!member.permissions.has(PermissionFlagsBits.Administrator)) {
            return interaction.reply({
                content: '❌ You need Administrator permission to use this command!',
                ephemeral: true
            });
        }

        const targetUser = interaction.options.getUser('user');
        const userId = targetUser.id;

        await interaction.deferReply({ ephemeral: true });

        // Check if user is already in the server
        try {
            const existingMember = await interaction.guild.members.fetch(userId);
            return interaction.editReply({
                content: `❌ ${targetUser.tag} is already in this server!`
            });
        } catch (error) {
            // User not in server, continue
        }

        // Check if user has authorized
        if (!config.userTokens || !config.userTokens[userId]) {
            return interaction.editReply({
                content: `❌ ${targetUser.tag} has not authorized the bot yet!\nThey need to run \`/authorize\` first.`
            });
        }

        const userToken = config.userTokens[userId];

        // Try to add user to guild
        const result = await addUserToGuild(guildId, userId, userToken.access_token);

        if (result.success) {
            const embed = new EmbedBuilder()
                .setColor('#00FF00')
                .setTitle('✅ User Pulled Successfully')
                .setDescription(`${targetUser} has been added to the server!`)
                .setThumbnail(targetUser.displayAvatarURL())
                .setTimestamp();

            await interaction.editReply({ embeds: [embed] });

            // Log the pull
            const guildConfig = config.guilds[guildId];
            const logChannel = interaction.guild.channels.cache.get(guildConfig?.logChannel);
            if (logChannel) {
                const logEmbed = new EmbedBuilder()
                    .setColor('#FFA500')
                    .setTitle('👥 User Pulled to Server')
                    .addFields(
                        { name: 'User', value: `${targetUser.tag}`, inline: true },
                        { name: 'Pulled By', value: `${interaction.user.tag}`, inline: true },
                        { name: 'User ID', value: userId, inline: true }
                    )
                    .setTimestamp();

                logChannel.send({ embeds: [logEmbed] });
            }
        } else {
            return interaction.editReply({
                content: `❌ Failed to pull ${targetUser.tag}!\n**Error:** ${result.error}\n\nThey may need to reauthorize with \`/authorize\`.`
            });
        }
    }

    // ===============================
    // 🆕 /togglepull command
    // ===============================
    if (interaction.commandName === 'togglepull') {
        if (!member.permissions.has(PermissionFlagsBits.Administrator)) {
            return interaction.reply({
                content: '❌ You need Administrator permission!',
                ephemeral: true
            });
        }

        if (!config.guilds[guildId]) {
            config.guilds[guildId] = {};
        }

        config.guilds[guildId].pullEnabled = !config.guilds[guildId].pullEnabled;
        saveConfig();

        const status = config.guilds[guildId].pullEnabled ? '✅ Enabled' : '❌ Disabled';

        return interaction.reply({
            content: `Pull feature has been ${status}`,
            ephemeral: true
        });
    }
});

// ===============================
// ✅ Verification Button
// ===============================
client.on('interactionCreate', async interaction => {
    if (!interaction.isButton()) return;
    if (interaction.customId !== 'verify') return;

    const guildId = interaction.guild.id;
    const guildConfig = config.guilds[guildId];

    if (!guildConfig || !guildConfig.verifiedRole) {
        return interaction.reply({
            content: '❌ No verified role set! Ask an admin to run `/setverifiedrole`.',
            ephemeral: true
        });
    }

    const role = interaction.guild.roles.cache.get(guildConfig.verifiedRole);

    if (!role) {
        return interaction.reply({
            content: '❌ The saved verified role no longer exists! Admin must run `/setverifiedrole` again.',
            ephemeral: true
        });
    }

    if (interaction.member.roles.cache.has(role.id)) {
        return interaction.reply({
            content: '✅ You are already verified!',
            ephemeral: true
        });
    }

    // Generate OAuth URL
    const authUrl = generateAuthUrl(interaction.user.id, guildId, 'verify');

    const embed = new EmbedBuilder()
        .setColor('#5865F2')
        .setTitle('🔐 Complete Verification')
        .setDescription('Click the button below to authorize and complete verification.\n\n**This will:**\n• Verify your Discord account\n• Grant you access to the server')
        .setTimestamp();

    const button = new ButtonBuilder()
        .setLabel('✅ Verify Now')
        .setStyle(ButtonStyle.Link)
        .setURL(authUrl);

    const row = new ActionRowBuilder().addComponents(button);

    await interaction.reply({
        embeds: [embed],
        components: [row],
        ephemeral: true
    });
});

// ===============================
// ✅ Register Commands
// ===============================
async function registerCommands() {
    await client.application.commands.set([
        {
            name: 'setup',
            description: 'Setup the verification system'
        },
        {
            name: 'setverifiedrole',
            description: 'Choose which role is given when a user verifies',
            options: [
                {
                    name: 'role',
                    description: 'Role to give',
                    type: 8,
                    required: true
                }
            ]
        },
        {
            name: 'authorize',
            description: 'Authorize the bot to add you to servers (required for /pull)'
        },
        {
            name: 'pull',
            description: 'Pull a user into this server (Admin only)',
            options: [
                {
                    name: 'user',
                    description: 'User to pull',
                    type: 6,
                    required: true
                }
            ]
        },
        {
            name: 'togglepull',
            description: 'Enable or disable the pull feature for this server (Admin only)'
        }
    ]);

    console.log('✅ Slash commands registered.');
}

// ===============================
// 🌐 OAuth Callback Server
// ===============================
function startCallbackServer() {
    const app = express();
    app.use(express.json());

    app.get('/callback', async (req, res) => {
        const code = req.query.code;
        const state = req.query.state;

        console.log('📥 Callback received');
        console.log('Code:', code ? 'Present' : 'Missing');
        console.log('State:', state ? 'Present' : 'Missing');

        if (!code || !state) {
            console.error('❌ Missing code or state parameter');
            return res.send(generateHTML('error', 'Missing authorization code.'));
        }

        try {
            // Decode state
            const stateData = JSON.parse(Buffer.from(state, 'base64').toString());
            const { userId, guildId, action } = stateData;

            console.log(`📥 Processing ${action} for user ${userId} in guild ${guildId}`);

            // Exchange code for token
            const tokenData = await exchangeCode(code);
            
            if (!tokenData) {
                console.error('❌ Failed to exchange code for token');
                return res.send(generateHTML('error', 'Failed to get access token. Please try again.'));
            }

            console.log('✅ Token obtained successfully');

            // Store token
            if (!config.userTokens) {
                config.userTokens = {};
            }
            config.userTokens[userId] = {
                access_token: tokenData.access_token,
                refresh_token: tokenData.refresh_token,
                expires_at: Date.now() + (tokenData.expires_in * 1000)
            };
            saveConfig();
            console.log('💾 Token saved to config');

            // If this is a verification action, give the role
            if (action === 'verify') {
                console.log('🔍 Attempting to verify user...');
                
                const guild = client.guilds.cache.get(guildId);
                if (!guild) {
                    console.error('❌ Guild not found:', guildId);
                    return res.send(generateHTML('error', 'Server not found. Please try again.'));
                }
                console.log('✅ Guild found:', guild.name);

                const member = await guild.members.fetch(userId).catch((err) => {
                    console.error('❌ Failed to fetch member:', err);
                    return null;
                });
                
                if (!member) {
                    console.error('❌ Member not found in guild');
                    return res.send(generateHTML('error', 'You are not in this server. Please join first.'));
                }
                console.log('✅ Member found:', member.user.tag);

                const guildConfig = config.guilds[guildId];
                
                if (!guildConfig) {
                    console.error('❌ Guild config not found');
                    return res.send(generateHTML('error', 'Server not configured. Ask admin to run /setup'));
                }

                if (!guildConfig.verifiedRole) {
                    console.error('❌ Verified role not set');
                    return res.send(generateHTML('error', 'Verified role not set. Ask admin to run /setverifiedrole'));
                }
                
                const role = guild.roles.cache.get(guildConfig.verifiedRole);
                
                if (!role) {
                    console.error('❌ Role not found:', guildConfig.verifiedRole);
                    return res.send(generateHTML('error', 'Verified role no longer exists. Ask admin to run /setverifiedrole again.'));
                }
                console.log('✅ Role found:', role.name);
                
                if (member.roles.cache.has(role.id)) {
                    console.log('⚠️ User already has the role');
                    return res.send(generateHTML('success', 'Already Verified!', 'You already have the verified role.'));
                }

                try {
                    await member.roles.add(role);
                    console.log(`✅ Successfully gave verified role to ${member.user.tag}`);

                    // Get inviter info
                    let inviterInfo = '';
                    if (guildConfig.invites && guildConfig.invites[userId]) {
                        const inviterData = guildConfig.invites[userId];
                        const inviter = await guild.members.fetch(inviterData.inviterId).catch(() => null);
                        
                        if (inviter) {
                            const inviterCount = Object.values(guildConfig.invites).filter(
                                inv => inv.inviterId === inviterData.inviterId
                            ).length;
                            inviterInfo = `\n👤 **Invited by:** ${inviter.user}\n📊 **Total Invites:** ${inviterCount}`;
                        }
                    }

                    // Send welcome message
                    const welcomeChannel = guild.channels.cache.get(guildConfig.welcomeChannel);
                    if (welcomeChannel) {
                        const welcomeEmbed = new EmbedBuilder()
                            .setColor('#00FF00')
                            .setTitle('🎉 New Member Verified!')
                            .setDescription(`Welcome <@${userId}> to the server!${inviterInfo}`)
                            .setThumbnail(member.user.displayAvatarURL())
                            .setTimestamp();

                        await welcomeChannel.send({ embeds: [welcomeEmbed] }).catch(err => {
                            console.error('❌ Failed to send welcome message:', err);
                        });
                    }

                    // Log verification
                    const logChannel = guild.channels.cache.get(guildConfig.logChannel);
                    if (logChannel) {
                        const logFields = [
                            { name: 'User', value: member.user.tag, inline: true },
                            { name: 'ID', value: userId, inline: true },
                            { name: 'Created', value: `<t:${Math.floor(member.user.createdTimestamp / 1000)}:R>` }
                        ];

                        if (guildConfig.invites && guildConfig.invites[userId]) {
                            const inviterData = guildConfig.invites[userId];
                            const inviter = await guild.members.fetch(inviterData.inviterId).catch(() => null);
                            
                            if (inviter) {
                                const count = Object.values(guildConfig.invites).filter(
                                    inv => inv.inviterId === inviterData.inviterId
                                ).length;
                                
                                logFields.push({ name: 'Invited By', value: inviter.user.tag, inline: true });
                                logFields.push({ name: 'Inviter Total', value: `${count} members`, inline: true });
                            }
                        }

                        const logEmbed = new EmbedBuilder()
                            .setColor('#00FF00')
                            .setTitle('✅ Member Verified')
                            .addFields(logFields)
                            .setThumbnail(member.user.displayAvatarURL())
                            .setTimestamp();

                        await logChannel.send({ embeds: [logEmbed] }).catch(err => {
                            console.error('❌ Failed to send log:', err);
                        });
                    }

                    return res.send(generateHTML('success', 'Verification Successful!', 'You have been verified and can now access the server.'));
                } catch (roleError) {
                    console.error('❌ Failed to add role:', roleError);
                    return res.send(generateHTML('error', 'Failed to assign role. Make sure the bot has permissions and its role is above the verified role.'));
                }
            } else {
                // Authorization for pull feature
                console.log('✅ Authorization completed for pull feature');
                res.send(generateHTML('success', 'Authorization Successful!', 'Server admins can now pull you into their servers.'));
            }

        } catch (error) {
            console.error('❌ Callback error:', error);
            res.send(generateHTML('error', 'An error occurred during verification. Check bot console for details.'));
        }
    });

    const PORT = process.env.PORT || 3000;
    app.listen(PORT, () => {
        console.log(`✅ OAuth callback server running on http://localhost:${PORT}`);
        console.log(`⚠️  In Discord Developer Portal, set redirect URI to: http://localhost:${PORT}/callback`);
        console.log(`⚠️  Or use ngrok for testing: ngrok http ${PORT}`);
    });
}

// ===============================
// 🎨 HTML Generator
// ===============================
function generateHTML(type, title, message = '') {
    const colors = {
        success: { bg: '#10b981', icon: '✅' },
        error: { bg: '#ef4444', icon: '❌' }
    };

    const { bg, icon } = colors[type];

    return `
        <!DOCTYPE html>
        <html lang="en">
        <head>
            <meta charset="UTF-8">
            <meta name="viewport" content="width=device-width, initial-scale=1.0">
            <title>${title}</title>
            <style>
                * {
                    margin: 0;
                    padding: 0;
                    box-sizing: border-box;
                }
                body {
                    font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif;
                    background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
                    display: flex;
                    justify-content: center;
                    align-items: center;
                    height: 100vh;
                    margin: 0;
                }
                .container {
                    background: white;
                    padding: 40px;
                    border-radius: 15px;
                    box-shadow: 0 10px 40px rgba(0,0,0,0.2);
                    text-align: center;
                    max-width: 500px;
                    animation: slideIn 0.5s ease-out;
                }
                @keyframes slideIn {
                    from {
                        opacity: 0;
                        transform: translateY(-20px);
                    }
                    to {
                        opacity: 1;
                        transform: translateY(0);
                    }
                }
                .icon {
                    font-size: 64px;
                    margin-bottom: 20px;
                }
                h1 {
                    color: ${bg};
                    margin-bottom: 10px;
                }
                p {
                    color: #666;
                    line-height: 1.6;
                }
                strong {
                    color: #333;
                    display: block;
                    margin-top: 15px;
                }
            </style>
        </head>
        <body>
            <div class="container">
                <div class="icon">${icon}</div>
                <h1>${title}</h1>
                ${message ? `<p>${message}</p>` : ''}
                <strong>You can close this window.</strong>
            </div>
        </body>
        </html>
    `;
}

// ===============================
// 🚀 Login Bot
// ===============================
client.login("MTQzNjQyMDQzNjU3MjM3MzExMg.G8dBS6.hOVSlq07tD63qyd771tMHtUlD62HeIYmvp0_Z0"); // REGENERATE YOUR TOKEN!
