"""Tests for the ffprobe-less ffmpeg probe fallback parser."""

import pytest

from openwhispr_whisperx.audio import AudioProbe, parse_ffmpeg_probe_output
from openwhispr_whisperx.errors import WorkerError

WHATSAPP_STDERR = """\
Input #0, mov,mp4,m4a,3gp,3g2,mj2, from 'voice.mp4':
  Metadata:
    major_brand     : mp42
  Duration: 00:14:30.81, start: 0.000000, bitrate: 68 kb/s
  Stream #0:0[0x1](und): Audio: aac (LC) (mp4a / 0x6134706D), 48000 Hz, mono, fltp, 65 kb/s (default)
Output #0, null, to 'pipe:':
"""

STEREO_STDERR = """\
Input #0, wav, from 'x.wav':
  Duration: 01:02:03.50, bitrate: 1536 kb/s
  Stream #0:0: Audio: pcm_s16le ([1][0][0][0] / 0x0001), 16000 Hz, 2 channels, s16, 512 kb/s
"""

VIDEO_ONLY_STDERR = """\
Input #0, mov,mp4,m4a,3gp,3g2,mj2, from 'clip.mp4':
  Duration: 00:00:10.00, start: 0.000000, bitrate: 4000 kb/s
  Stream #0:0[0x1]: Video: h264 (High), yuv420p, 1920x1080, 30 fps
"""


def test_parses_whatsapp_style_metadata():
    probe = parse_ffmpeg_probe_output(WHATSAPP_STDERR)
    assert isinstance(probe, AudioProbe)
    assert probe.duration_seconds == pytest.approx(870.81, abs=0.01)
    assert probe.codec == "aac"
    assert probe.sample_rate == 48000
    assert probe.channels == 1


def test_parses_multichannel_and_long_duration():
    probe = parse_ffmpeg_probe_output(STEREO_STDERR)
    assert probe.duration_seconds == pytest.approx(3723.5, abs=0.01)
    assert probe.codec == "pcm_s16le"
    assert probe.sample_rate == 16000
    assert probe.channels == 2


def test_rejects_video_only_input():
    with pytest.raises(WorkerError) as exc_info:
        parse_ffmpeg_probe_output(VIDEO_ONLY_STDERR)
    assert exc_info.value.code == "AUDIO_UNSUPPORTED"


def test_missing_duration_defaults_to_zero():
    probe = parse_ffmpeg_probe_output("Stream #0:0: Audio: mp3, 44100 Hz, stereo")
    assert probe.duration_seconds == 0.0
    assert probe.codec == "mp3"
    assert probe.channels == 2
