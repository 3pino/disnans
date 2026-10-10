package dev.disnans.notifier

import android.content.Context
import android.media.AudioDeviceInfo
import android.media.AudioManager
import android.os.Build

/**
 * 通話中の音の出力先（受話口・スピーカー・有線イヤホン・Bluetooth）の切り替え。
 * Android 12（API 31）以降は getAvailableCommunicationDevices / setCommunicationDevice、
 * それより前は setSpeakerphoneOn / startBluetoothSco を使う。
 * 通話のあいだ（CallService が動いている間）は MODE_IN_COMMUNICATION にする。
 */
data class AudioOutput(val id: String, val label: String, val kind: String)

object CallAudio {
  private var previousMode: Int? = null

  /** 通話用に音の経路を整える。始めたときに、イヤホンがあればそれ、なければスピーカーにする */
  fun begin(context: Context) {
    val am = manager(context)
    if (previousMode == null) previousMode = am.mode
    am.mode = AudioManager.MODE_IN_COMMUNICATION
    val outs = list(context)
    val first = outs.firstOrNull { it.kind == "bluetooth" } ?: outs.firstOrNull { it.kind == "wired" } ?: outs.firstOrNull { it.kind == "speaker" }
    if (first != null) set(context, first.id)
  }

  /** 通話が終わったら元に戻す */
  fun end(context: Context) {
    val am = manager(context)
    try {
      if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
        am.clearCommunicationDevice()
      } else {
        legacyReset(am)
      }
    } catch (e: Exception) {
      // 元に戻せなくても続ける
    }
    previousMode?.let { am.mode = it }
    previousMode = null
  }

  @Suppress("DEPRECATION")
  private fun legacyReset(am: AudioManager) {
    am.stopBluetoothSco()
    am.isBluetoothScoOn = false
    am.isSpeakerphoneOn = false
  }

  /** 使える出力先。id は set に渡す */
  fun list(context: Context): List<AudioOutput> {
    val am = manager(context)
    val devices: List<AudioDeviceInfo> = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
      am.availableCommunicationDevices
    } else {
      am.getDevices(AudioManager.GET_DEVICES_OUTPUTS).toList()
    }
    val out = ArrayList<AudioOutput>()
    var hasSpeaker = false
    var hasEarpiece = false
    for (d in devices) {
      val kind = kindOf(d.type) ?: continue
      when (kind) {
        "speaker" -> if (hasSpeaker) continue else hasSpeaker = true
        "earpiece" -> if (hasEarpiece) continue else hasEarpiece = true
      }
      val name = d.productName?.toString().orEmpty()
      val label = when (kind) {
        "earpiece" -> "受話口"
        "speaker" -> "スピーカー"
        "wired" -> if (name.isNotEmpty()) "イヤホン（$name）" else "イヤホン"
        else -> if (name.isNotEmpty()) "Bluetooth（$name）" else "Bluetooth"
      }
      val id = if (kind == "earpiece" || kind == "speaker") kind else "$kind:${d.id}"
      // Bluetooth は A2DP と SCO が両方出ることがある。通話は SCO / LE なので、同じ名前なら重ねない
      if (out.any { it.kind == kind && it.label == label }) continue
      out.add(AudioOutput(id, label, kind))
    }
    return out
  }

  /** 現在の出力先の id（わからなければ null） */
  fun current(context: Context): String? {
    val am = manager(context)
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
      val d = am.communicationDevice ?: return null
      val kind = kindOf(d.type) ?: return null
      val id = if (kind == "earpiece" || kind == "speaker") kind else "$kind:${d.id}"
      // 同じ種類・名前を重ねて隠した分があるので、一覧にある id に寄せる
      val outs = list(context)
      return outs.firstOrNull { it.id == id }?.id ?: outs.firstOrNull { it.kind == kind }?.id
    }
    @Suppress("DEPRECATION")
    return when {
      am.isBluetoothScoOn -> list(context).firstOrNull { it.kind == "bluetooth" }?.id
      am.isSpeakerphoneOn -> "speaker"
      else -> list(context).firstOrNull { it.kind == "wired" }?.id ?: "earpiece"
    }
  }

  /** 出力先を切り替える。見つからなければ false */
  fun set(context: Context, id: String): Boolean {
    val am = manager(context)
    val target = list(context).firstOrNull { it.id == id } ?: return false
    if (am.mode != AudioManager.MODE_IN_COMMUNICATION) am.mode = AudioManager.MODE_IN_COMMUNICATION
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
      val dev = am.availableCommunicationDevices.firstOrNull { d ->
        val kind = kindOf(d.type)
        kind == target.kind && (kind == "earpiece" || kind == "speaker" || "$kind:${d.id}" == id || d.productName?.toString().orEmpty().let { n -> target.label.contains(n) && n.isNotEmpty() })
      } ?: return false
      return am.setCommunicationDevice(dev)
    }
    @Suppress("DEPRECATION")
    when (target.kind) {
      "speaker" -> {
        am.stopBluetoothSco(); am.isBluetoothScoOn = false
        am.isSpeakerphoneOn = true
      }
      "bluetooth" -> {
        am.isSpeakerphoneOn = false
        am.startBluetoothSco(); am.isBluetoothScoOn = true
      }
      else -> {
        // 受話口・有線イヤホンは、スピーカーと Bluetooth を切れば自動でそちらへ出る
        am.stopBluetoothSco(); am.isBluetoothScoOn = false
        am.isSpeakerphoneOn = false
      }
    }
    return true
  }

  private fun manager(context: Context) = context.getSystemService(Context.AUDIO_SERVICE) as AudioManager

  private fun kindOf(type: Int): String? = when (type) {
    AudioDeviceInfo.TYPE_BUILTIN_EARPIECE -> "earpiece"
    AudioDeviceInfo.TYPE_BUILTIN_SPEAKER -> "speaker"
    AudioDeviceInfo.TYPE_WIRED_HEADSET, AudioDeviceInfo.TYPE_WIRED_HEADPHONES, AudioDeviceInfo.TYPE_USB_HEADSET -> "wired"
    AudioDeviceInfo.TYPE_BLUETOOTH_SCO -> "bluetooth"
    else -> if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S && (type == AudioDeviceInfo.TYPE_BLE_HEADSET || type == AudioDeviceInfo.TYPE_HEARING_AID)) "bluetooth" else null
  }
}
