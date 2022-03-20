import { MessageEmbed } from 'discord.js';
import {
  AudioPlayerStatus,
  createAudioPlayer,
  createAudioResource,
  joinVoiceChannel,
  StreamType,
} from '@discordjs/voice';
import pg from 'pg';

import { EventEmitter } from 'node:events';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

import { gameLength } from './config.js';
import Song from './song.js';
import { getPlaylist, getPlaylistMetadata } from './spotify.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

export default class Game extends EventEmitter {
  constructor(textChannel, voiceChannel, playlist, length) {
    super();
    this.length = length || gameLength;
    this.score = {};
    this.playlist = playlist;

    this.countdown = createAudioResource(join(__dirname, 'countdown.mp3'), {
      inputType: StreamType.Raw,
    });

    this.textChannel = textChannel;
    this.voiceChannel = voiceChannel;

    const countdownPlayer = createAudioPlayer();
    this.connection = joinVoiceChannel({
      channelId: voiceChannel.id,
      guildId: voiceChannel.guild.id,
      adapterCreator: voiceChannel.guild.voiceAdapterCreator,
    });

    this.player = createAudioPlayer();

    this.connection.subscribe(countdownPlayer);
    countdownPlayer.play(this.countdown);
    this.initSongs();

    countdownPlayer.once(AudioPlayerStatus.Idle, () => {
      this.init();
    });
  }

  async initSongs() {
    const tracks = [];
    if (this.playlist) {
      const playlistMetadata = await getPlaylistMetadata(this.playlist);
      const playlistMetadataEmbed = new MessageEmbed()
        .setTitle(`Fetching playlist ${playlistMetadata.name}`)
        .setDescription(`Total songs: ${playlistMetadata.totalSongs}\n\nLikes: ${playlistMetadata.followers}`)
        .setThumbnail(playlistMetadata.image)
      this.textChannel.send({
        embeds: [playlistMetadataEmbed],
      })
      const playlistTracks = await getPlaylist(this.playlist);
      tracks.push(...playlistTracks.sort(() => Math.random() - Math.random()).slice(0, this.length));
    } else {
      const pgClient = new pg.Pool();
      const random = await pgClient.query(`SELECT * FROM quiz_songs ORDER BY RANDOM() LIMIT ${this.length}`);
      tracks.push(...random.rows.map(row => row.song));
    }

    this.songs = tracks.map((track, i) => new Song(i + 1, track, this.textChannel));
    return this.init();
  }

  init() {
    if (this.songs && this.countdown.ended) {
      this.connection.subscribe(this.player);
      this.currentSong = 0;
      this.playNext();
    }
  }

  playNext() {    
    const song = this.songs[this.currentSong];
    song.play(this.player);
    song.on('guess', (id) => {
      this.score[id] = this.score[id] || 0;
    });
    song.once('done', () => {
      if (!!song.artistGuessed && song.artistGuessed == song.titleGuessed) {
        this.score[song.artistGuessed] += 3;
      } else {
        if (!!song.artistGuessed) {
          this.score[song.artistGuessed] += 1;
        }
        if (!!song.titleGuessed) {
          this.score[song.titleGuessed] += 1;
        }
      }
      this.currentSong += 1;

      if (this.currentSong >= this.length) {
        this.textChannel.send({
          embeds: [song.embed(this.length, this.formattedScore())],
        })
        this.textChannel.send({
          embeds: [new MessageEmbed().setTitle("**Music Quiz Ranking**").setDescription(this.formattedScore())],
        });
        this.connection.disconnect();
        this.emit('end');
      } else {
        this.textChannel.send({
          embeds: [song.embed(this.length, this.formattedScore())],
        });
        this.playNext();
      }
    });
  }

  formattedScore() {
    const medals = {
      0: "🥇",
      1: "🥈",
      2: "🥉",
    };
    return Object.entries(this.score).sort((a, b) => b[1] - a[1]).map((entry, i) => {
      const id = entry[0];
      const score = entry[1];
      const place = medals[i] || `${i + 1}`;
      const spacing = medals[i] ? "\n" : "";
      return `${place} - <@${id}> - ${score} pts${spacing}`;
    }).join("\n");
  }
}
