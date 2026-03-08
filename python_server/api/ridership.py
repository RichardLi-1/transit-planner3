"""
Ridership API endpoints for querying station boardings data.
"""
from typing import Optional
from fastapi import APIRouter, HTTPException
from pydantic import BaseModel
from sqlalchemy import func, select
from sqlalchemy.orm import Session

from python_utils.db.session import get_session
from python_utils.db.models.stop import Stop
from python_utils.db.models.demand_summary import StopDemandSummary
from python_utils.db.models.route import Route

router = APIRouter(prefix="/api/ridership", tags=["ridership"])


class StationRidershipRequest(BaseModel):
    station_name: str


class StationRidershipResponse(BaseModel):
    station_name: str
    total_boardings: float


class LineRidershipRequest(BaseModel):
    line_name: str


class StationData(BaseModel):
    name: str
    ridership: float


class LineRidershipResponse(BaseModel):
    line_name: str
    stations: list[StationData]


@router.post("/station", response_model=StationRidershipResponse)
async def get_station_ridership(
    request: StationRidershipRequest,
) -> StationRidershipResponse:
    """
    Get total daily ridership (boardings) for a specific station.
    
    Aggregates all boardings across all time buckets and routes for the station.
    Uses the most recent service date available in the database.
    """
    try:
        session: Session = get_session()
        
        # Find the stop by name (case-insensitive partial match)
        stop_query = select(Stop).where(
            Stop.stop_name.ilike(f"%{request.station_name}%")
        )
        stop = session.execute(stop_query).scalar_one_or_none()
        
        if not stop:
            raise HTTPException(
                status_code=404,
                detail=f"Station '{request.station_name}' not found"
            )
        
        # Get the most recent service date
        most_recent_date_query = select(
            func.max(StopDemandSummary.service_date)
        ).where(
            StopDemandSummary.stop_pk == stop.stop_pk
        )
        most_recent_date = session.execute(most_recent_date_query).scalar_one_or_none()
        
        if not most_recent_date:
            # No ridership data available for this station
            return StationRidershipResponse(
                station_name=stop.stop_name or request.station_name,
                total_boardings=0.0
            )
        
        # Sum all boardings for this station on the most recent date
        ridership_query = select(
            func.sum(StopDemandSummary.boardings)
        ).where(
            StopDemandSummary.stop_pk == stop.stop_pk,
            StopDemandSummary.service_date == most_recent_date,
            StopDemandSummary.boardings.isnot(None)
        )
        
        total_boardings = session.execute(ridership_query).scalar_one_or_none()
        
        return StationRidershipResponse(
            station_name=stop.stop_name or request.station_name,
            total_boardings=float(total_boardings) if total_boardings else 0.0
        )
        
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(
            status_code=500,
            detail=f"Error fetching ridership data: {str(e)}"
        )


@router.post("/line", response_model=LineRidershipResponse)
async def get_line_ridership(
    request: LineRidershipRequest,
) -> LineRidershipResponse:
    """
    Get ridership data for all stations on a specific line/route.
    
    Returns a list of stations with their total daily boardings.
    """
    try:
        session: Session = get_session()
        
        # Find the route by name (case-insensitive partial match)
        route_query = select(Route).where(
            Route.route_short_name.ilike(f"%{request.line_name}%")
        )
        route = session.execute(route_query).scalar_one_or_none()
        
        if not route:
            # Try matching by long name
            route_query = select(Route).where(
                Route.route_long_name.ilike(f"%{request.line_name}%")
            )
            route = session.execute(route_query).scalar_one_or_none()
        
        if not route:
            raise HTTPException(
                status_code=404,
                detail=f"Line '{request.line_name}' not found"
            )
        
        # Get the most recent service date for this route
        most_recent_date_query = select(
            func.max(StopDemandSummary.service_date)
        ).where(
            StopDemandSummary.route_pk == route.route_pk
        )
        most_recent_date = session.execute(most_recent_date_query).scalar_one_or_none()
        
        if not most_recent_date:
            return LineRidershipResponse(
                line_name=route.route_short_name or request.line_name,
                stations=[]
            )
        
        # Get all stations and their ridership for this route
        ridership_query = (
            select(
                Stop.stop_name,
                func.sum(StopDemandSummary.boardings).label("total_boardings")
            )
            .join(StopDemandSummary, Stop.stop_pk == StopDemandSummary.stop_pk)
            .where(
                StopDemandSummary.route_pk == route.route_pk,
                StopDemandSummary.service_date == most_recent_date,
                StopDemandSummary.boardings.isnot(None),
                Stop.stop_name.isnot(None)
            )
            .group_by(Stop.stop_name)
            .order_by(Stop.stop_name)
        )
        
        results = session.execute(ridership_query).all()
        
        stations = [
            StationData(name=row.stop_name, ridership=float(row.total_boardings))
            for row in results
        ]
        
        return LineRidershipResponse(
            line_name=route.route_short_name or request.line_name,
            stations=stations
        )
        
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(
            status_code=500,
            detail=f"Error fetching line ridership data: {str(e)}"
        )
