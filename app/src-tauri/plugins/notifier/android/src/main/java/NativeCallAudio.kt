package dev.disnans.notifier

import android.media.AudioAttributes
import android.media.AudioFormat
import android.media.AudioManager
import android.media.AudioRecord
import android.media.AudioTrack
import android.media.MediaRecorder
import android.media.audiofx.AcousticEchoCanceler
import android.media.audiofx.AudioEffect
import android.media.audiofx.AutomaticGainControl
import android.media.audiofx.NoiseSuppressor
import android.os.SystemClock
import java.util.concurrent.ConcurrentHashMap
import kotlin.math.max

/** Android のデバイスだけを供給する。取得・停止・スレッドへの引き渡しは JVM と共通の実装に委譲。 */
internal class NativeCallAudio(
  mixer: NativeMixer,
  micVolume: Double,
  private val rawInput: Boolean,
  sender: (Long, ByteArray) -> Unit,
  onFailure: (String) -> Unit,
) : AudioRun {
  val effects = ConcurrentHashMap<String, String>()
  private val lifecycle = NativeCallAudioLifecycle(
    mixer, ::openRecorder, ::openPlayer, sender, onFailure, SystemClock::elapsedRealtime,
  ).also { it.setMicVolume(micVolume) }

  override fun start(): String? = lifecycle.start()
  override fun stop() = lifecycle.stop()
  override fun setCapture(enabled: Boolean) = lifecycle.setCapture(enabled)
  override fun setMicVolume(volume: Double) = lifecycle.setMicVolume(volume)
  override fun awaitReleased(timeoutMs: Long): Boolean = lifecycle.awaitReleased(timeoutMs)
  override fun audioCounters(): Map<String, Long> = lifecycle.audioCounters() + effects.entries.associate { "effect.${it.key}.${it.value}" to 1L }

  private fun openRecorder(): NativeCallAudioLifecycle.Recorder {
    val size = AudioRecord.getMinBufferSize(NativePcm.RATE, AudioFormat.CHANNEL_IN_MONO, AudioFormat.ENCODING_PCM_16BIT)
    if (size <= 0) throw NativeCallAudioLifecycle.Failure("record_unsupported")
    val rec = AudioRecord(
      if (rawInput) MediaRecorder.AudioSource.MIC else MediaRecorder.AudioSource.VOICE_COMMUNICATION,
      NativePcm.RATE, AudioFormat.CHANNEL_IN_MONO, AudioFormat.ENCODING_PCM_16BIT, max(size, FRAME_BYTES * 4),
    )
    val ownedEffects = ArrayList<AudioEffect>()
    var transferred = false
    try {
      if (rec.state != AudioRecord.STATE_INITIALIZED) throw NativeCallAudioLifecycle.Failure("record_init")
      if (!rawInput) {
        attach("aec", AcousticEchoCanceler::isAvailable, { AcousticEchoCanceler.create(rec.audioSessionId) }, ownedEffects)
        attach("ns", NoiseSuppressor::isAvailable, { NoiseSuppressor.create(rec.audioSessionId) }, ownedEffects)
        attach("agc", AutomaticGainControl::isAvailable, { AutomaticGainControl.create(rec.audioSessionId) }, ownedEffects)
      }
      val port = object : NativeCallAudioLifecycle.Recorder {
        override fun start() { rec.startRecording() }
        override fun read(buf: ShortArray, offset: Int, length: Int): Int = rec.read(buf, offset, length, AudioRecord.READ_BLOCKING)
        override fun stopRead() { try { rec.stop() } catch (_: Exception) {} }
        override fun release() {
          try {
            stopRead()
            for (effect in ownedEffects) try { effect.release() } catch (_: Exception) {}
          } finally { rec.release() }
        }
      }
      transferred = true
      return port
    } finally {
      if (!transferred) {
        for (effect in ownedEffects) try { effect.release() } catch (_: Exception) {}
        rec.release()
      }
    }
  }

  private fun openPlayer(): NativeCallAudioLifecycle.Player {
    val size = AudioTrack.getMinBufferSize(NativePcm.RATE, AudioFormat.CHANNEL_OUT_MONO, AudioFormat.ENCODING_PCM_16BIT)
    if (size <= 0) throw NativeCallAudioLifecycle.Failure("track_unsupported")
    val track = AudioTrack(
      AudioAttributes.Builder().setUsage(AudioAttributes.USAGE_VOICE_COMMUNICATION).setContentType(AudioAttributes.CONTENT_TYPE_SPEECH).build(),
      AudioFormat.Builder().setSampleRate(NativePcm.RATE).setChannelMask(AudioFormat.CHANNEL_OUT_MONO).setEncoding(AudioFormat.ENCODING_PCM_16BIT).build(),
      max(size, FRAME_BYTES * 4), AudioTrack.MODE_STREAM, AudioManager.AUDIO_SESSION_ID_GENERATE,
    )
    var transferred = false
    try {
      if (track.state != AudioTrack.STATE_INITIALIZED) throw NativeCallAudioLifecycle.Failure("track_init")
      val port = object : NativeCallAudioLifecycle.Player {
        override fun start() { track.play() }
        override fun write(buf: ShortArray, offset: Int, length: Int): Int = track.write(buf, offset, length)
        override fun flush() {
          // playing 中の flush は無効なので、必ず pause を先行する。
          try { track.pause() } catch (_: Exception) {}
          try { track.flush() } catch (_: Exception) {}
        }
        override fun stop() { try { track.stop() } catch (_: Exception) {} }
        override fun release() {
          try { flush(); stop() } finally { track.release() }
        }
      }
      transferred = true
      return port
    } finally { if (!transferred) track.release() }
  }

  private fun attach(name: String, available: () -> Boolean, create: () -> AudioEffect?, owned: MutableList<AudioEffect>) {
    try {
      if (!available()) { effects[name] = "unavailable"; return }
      val effect = create()
      if (effect == null) { effects[name] = "failed"; return }
      owned.add(effect) // enabled の失敗でも、取得した効果は必ず解放の対象に残す。
      effect.enabled = true
      effects[name] = "on"
    } catch (_: Exception) { effects[name] = "failed" }
  }

  companion object {
    private const val FRAME_BYTES = NativePcm.FRAME * 2
    /** 形式の確認だけ。通話が一覧に載る前に、別の録音デバイスを作らない。 */
    @Suppress("UNUSED_PARAMETER")
    fun preflight(rawInput: Boolean = false): String? = try {
      when {
        AudioRecord.getMinBufferSize(NativePcm.RATE, AudioFormat.CHANNEL_IN_MONO, AudioFormat.ENCODING_PCM_16BIT) <= 0 -> "record_unsupported"
        AudioTrack.getMinBufferSize(NativePcm.RATE, AudioFormat.CHANNEL_OUT_MONO, AudioFormat.ENCODING_PCM_16BIT) <= 0 -> "track_unsupported"
        else -> null
      }
    } catch (_: SecurityException) { "permission_lost" }
    catch (_: Exception) { "audio_unavailable" }

    fun leToShorts(bytes: ByteArray): ShortArray = NativePcm.leToShorts(bytes)
  }
}

internal object AndroidAudioFactory : AudioFactory {
  override fun preflight(rawInput: Boolean): String? = NativeCallAudio.preflight(rawInput)
  override fun create(rawInput: Boolean, micVolume: Double, mixer: NativeMixer, sender: (Long, ByteArray) -> Unit, onFailure: (String) -> Unit): AudioRun =
    NativeCallAudio(mixer, micVolume, rawInput, sender, onFailure)
}
