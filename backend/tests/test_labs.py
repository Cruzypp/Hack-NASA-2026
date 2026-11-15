import pandas as pd

from astra import db, labs


def test_osd_labs_use_slow_personal_baseline_and_raise_findings(client, tmp_path):
    offsets = range(-10, -2)
    cbc = pd.DataFrame({
        "Sample Name": [f"C001_whole-blood_L{offset}_cbc" for offset in offsets],
        "hemoglobin_value_percent": [14.0] * 7 + [20.0],
        "hemoglobin_range_min_percent": [5.0] * 8,
        "hemoglobin_range_max_percent": [25.0] * 8,
        "hematocrit_value_percent": [42.0] * 8,
        "hematocrit_range_min_percent": [10.0] * 8,
        "hematocrit_range_max_percent": [70.0] * 8,
        "white_blood_cell_count_value_thousand_per_microliter": [7.0] * 8,
        "white_blood_cell_count_range_min_thousand_per_microliter": [0.0] * 8,
        "white_blood_cell_count_range_max_thousand_per_microliter": [100.0] * 8,
        "platelet_count_value_thousand_per_microliter": [250.0] * 8,
        "platelet_count_range_min_thousand_per_microliter": [10.0] * 8,
        "platelet_count_range_max_thousand_per_microliter": [1500.0] * 8,
    })
    cmp = pd.DataFrame({
        "Sample Name": [f"C001_serum_L{offset}" for offset in offsets],
        "albumin_value_gram_per_deciliter": [4.0] * 8,
        "albumin_range_min_gram_per_deciliter": [0.0] * 8,
        "albumin_range_max_gram_per_deciliter": [10.0] * 8,
        "glucose_value_milligram_per_deciliter": [90.0] * 8,
        "glucose_range_min_milligram_per_deciliter": [20.0] * 8,
        "glucose_range_max_milligram_per_deciliter": [600.0] * 8,
        "creatinine_value_milligram_per_deciliter": [1.0] * 8,
        "creatinine_range_min_milligram_per_deciliter": [0.0] * 8,
        "creatinine_range_max_milligram_per_deciliter": [20.0] * 8,
        "sodium_value_millimol_per_liter": [140.0] * 8,
        "sodium_range_min_millimol_per_liter": [80.0] * 8,
        "sodium_range_max_millimol_per_liter": [200.0] * 8,
        "potassium_value_millimol_per_liter": [4.0] * 8,
        "potassium_range_min_millimol_per_liter": [1.0] * 8,
        "potassium_range_max_millimol_per_liter": [15.0] * 8,
    })
    cbc_path = tmp_path / "LSDS-7_CBC_TRANSFORMED.parquet"
    cmp_path = tmp_path / "LSDS-8_CMP_TRANSFORMED.parquet"
    cbc.to_parquet(cbc_path, index=False)
    cmp.to_parquet(cmp_path, index=False)

    report = labs.process_osd(
        client.app_state.conn,
        {"CBC": cbc_path, "CMP": cmp_path},
        {"C001": "CM-01"},
    )

    assert len(report["accepted"]) == 72
    assert report["alerts"]
    alert = db.one(client.app_state.conn, "SELECT * FROM alerts WHERE id = ?", report["alerts"][-1])
    assert alert["rule_id"] == "baseline-robust-z"
