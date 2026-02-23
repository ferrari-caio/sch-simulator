using System.Collections.Generic;
using FarmSim.Core.Geo;

namespace FarmSim.Core.Models;

/// <summary>
/// A named polygon representing a harvestable field block.
/// </summary>
/// <param name="Name">Human-readable field name.</param>
/// <param name="Boundary">Closed polygon boundary (implicit closure between last and first vertices).</param>
/// <param name="AreaSquareMeters">Area of the block in square meters.</param>
public sealed record FieldBlock(
    string Name,
    IReadOnlyList<GeoPoint> Boundary,
    double AreaSquareMeters
);
